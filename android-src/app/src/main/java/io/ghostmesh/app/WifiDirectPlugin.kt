package io.ghostmesh.app

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.wifi.p2p.WifiP2pConfig
import android.net.wifi.p2p.WifiP2pDevice
import android.net.wifi.p2p.WifiP2pManager
import android.net.wifi.p2p.nsd.WifiP2pDnsSdServiceInfo
import android.net.wifi.p2p.nsd.WifiP2pDnsSdServiceRequest
import android.os.Build
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * GhostMeshWifiDirect — Capacitor plugin bridging Android Wi-Fi P2P to the
 * TypeScript `WifiDirectTransport`.
 *
 * Flow
 *  1. startDiscovery(): register DNS-SD record `_ghostmesh._tcp` carrying the
 *     public advert (node id + public keys) in TXT, then discover peers.
 *  2. peerFound event  -> JS decides to connect()
 *  3. connect(): forms a P2P group; group owner opens a ServerSocket on PORT,
 *     clients dial it. Every socket is a newline-delimited JSON frame stream.
 *  4. send()/data events carry MeshPacket JSON.
 */
@CapacitorPlugin(
    name = "GhostMeshWifiDirect",
    permissions = [
        Permission(strings = [Manifest.permission.NEARBY_WIFI_DEVICES], alias = "nearby"),
        Permission(strings = [Manifest.permission.ACCESS_FINE_LOCATION], alias = "location"),
    ],
)
class WifiDirectPlugin : Plugin() {

    companion object {
        const val PORT = 47_337
        const val SERVICE_TYPE = "_ghostmesh._tcp"
    }

    private lateinit var manager: WifiP2pManager
    private lateinit var channel: WifiP2pManager.Channel
    private val io = Executors.newCachedThreadPool()
    private val sockets = ConcurrentHashMap<String, Socket>()
    private val peerTxt = ConcurrentHashMap<String, Map<String, String>>()
    private var server: ServerSocket? = null
    private var receiver: BroadcastReceiver? = null

    override fun load() {
        manager = context.getSystemService(Context.WIFI_P2P_SERVICE) as WifiP2pManager
        channel = manager.initialize(context, context.mainLooper, null)
    }

    @PluginMethod
    fun isAvailable(call: PluginCall) {
        val ok = context.packageManager.hasSystemFeature("android.hardware.wifi.direct")
        call.resolve(JSObject().put("available", ok))
    }

    @PluginMethod
    fun requestPermissions(call: PluginCall) {
        val alias = if (Build.VERSION.SDK_INT >= 33) "nearby" else "location"
        if (getPermissionState(alias) == com.getcapacitor.PermissionState.GRANTED) {
            call.resolve(JSObject().put("granted", true))
        } else {
            requestPermissionForAlias(alias, call, "permCallback")
        }
    }

    @PermissionCallback
    private fun permCallback(call: PluginCall) {
        val alias = if (Build.VERSION.SDK_INT >= 33) "nearby" else "location"
        call.resolve(JSObject().put("granted", getPermissionState(alias) == com.getcapacitor.PermissionState.GRANTED))
    }

    @PluginMethod
    fun startDiscovery(call: PluginCall) {
        val txt = HashMap<String, String>()
        call.getObject("txt")?.let { o -> o.keys().forEach { k -> txt[k] = o.getString(k) ?: "" } }
        val info = WifiP2pDnsSdServiceInfo.newInstance("ghostmesh", SERVICE_TYPE, txt)

        manager.addLocalService(channel, info, object : WifiP2pManager.ActionListener {
            override fun onSuccess() {}
            override fun onFailure(reason: Int) { notifyListeners("error", JSObject().put("reason", reason)) }
        })

        manager.setDnsSdResponseListeners(
            channel,
            { _, _, device -> emitPeerFound(device) },
            { _, record, device ->
                peerTxt[device.deviceAddress] = record
                emitPeerFound(device)
            },
        )
        manager.addServiceRequest(channel, WifiP2pDnsSdServiceRequest.newInstance(), null)
        manager.discoverServices(channel, object : WifiP2pManager.ActionListener {
            override fun onSuccess() { call.resolve() }
            override fun onFailure(reason: Int) { call.reject("discoverServices failed: $reason") }
        })

        registerReceiver()
        startServer()
    }

    @PluginMethod
    fun stopDiscovery(call: PluginCall) {
        manager.clearServiceRequests(channel, null)
        manager.clearLocalServices(channel, null)
        receiver?.let { context.unregisterReceiver(it) }
        receiver = null
        sockets.values.forEach { runCatching { it.close() } }
        sockets.clear()
        server?.close()
        server = null
        call.resolve()
    }

    @PluginMethod
    fun connect(call: PluginCall) {
        val addr = call.getString("deviceAddress") ?: return call.reject("deviceAddress required")
        val cfg = WifiP2pConfig().apply { deviceAddress = addr; groupOwnerIntent = 7 }
        manager.connect(channel, cfg, object : WifiP2pManager.ActionListener {
            override fun onSuccess() {
                manager.requestConnectionInfo(channel) { info ->
                    if (info.groupFormed && !info.isGroupOwner) {
                        io.execute {
                            runCatching {
                                val s = Socket()
                                s.connect(InetSocketAddress(info.groupOwnerAddress, PORT), 5000)
                                attach(addr, s)
                            }.onFailure { call.reject("socket: ${it.message}") }
                        }
                    }
                    call.resolve(
                        JSObject()
                            .put("groupOwner", info.isGroupOwner)
                            .put("host", info.groupOwnerAddress?.hostAddress ?: "")
                            .put("port", PORT),
                    )
                }
            }
            override fun onFailure(reason: Int) { call.reject("connect failed: $reason") }
        })
    }

    @PluginMethod
    fun disconnect(call: PluginCall) {
        val addr = call.getString("deviceAddress")
        sockets.remove(addr)?.let { runCatching { it.close() } }
        manager.removeGroup(channel, null)
        call.resolve()
    }

    @PluginMethod
    fun send(call: PluginCall) {
        val addr = call.getString("deviceAddress") ?: return call.reject("deviceAddress required")
        val data = call.getString("data") ?: return call.reject("data required")
        val s = sockets[addr] ?: return call.reject("not connected")
        io.execute {
            runCatching {
                val w = OutputStreamWriter(s.getOutputStream(), Charsets.UTF_8)
                w.write(data); w.write("\n"); w.flush()
                call.resolve(JSObject().put("bytes", data.toByteArray(Charsets.UTF_8).size))
            }.onFailure { call.reject("send: ${it.message}") }
        }
    }

    /* ------------------------------------------------------------------ */

    private fun emitPeerFound(device: WifiP2pDevice) {
        val txt = peerTxt[device.deviceAddress] ?: return // wait until TXT arrives
        val js = JSObject().put("deviceAddress", device.deviceAddress).put("deviceName", device.deviceName)
        val t = JSObject(); txt.forEach { (k, v) -> t.put(k, v) }
        js.put("txt", t)
        notifyListeners("peerFound", js)
    }

    private fun startServer() {
        if (server != null) return
        io.execute {
            runCatching {
                val ss = ServerSocket(PORT).also { server = it }
                while (!ss.isClosed) {
                    val s = ss.accept()
                    // Peer identity is resolved from the first frame (HELLO) by JS; key by remote addr for now.
                    attach(s.inetAddress.hostAddress ?: s.toString(), s)
                }
            }
        }
    }

    private fun attach(addr: String, s: Socket) {
        sockets[addr] = s
        io.execute {
            runCatching {
                val r = BufferedReader(InputStreamReader(s.getInputStream(), Charsets.UTF_8))
                while (true) {
                    val line = r.readLine() ?: break
                    notifyListeners("data", JSObject().put("deviceAddress", addr).put("data", line))
                }
            }
            sockets.remove(addr)
            notifyListeners("peerLost", JSObject().put("deviceAddress", addr))
        }
    }

    private fun registerReceiver() {
        if (receiver != null) return
        receiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context, i: Intent) {
                when (i.action) {
                    WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION -> {
                        val enabled = i.getIntExtra(WifiP2pManager.EXTRA_WIFI_STATE, -1) == WifiP2pManager.WIFI_P2P_STATE_ENABLED
                        notifyListeners("stateChanged", JSObject().put("enabled", enabled))
                    }
                    WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION -> manager.requestPeers(channel) { list ->
                        val present = list.deviceList.map { it.deviceAddress }.toSet()
                        peerTxt.keys.filter { it !in present }.forEach {
                            peerTxt.remove(it)
                            notifyListeners("peerLost", JSObject().put("deviceAddress", it))
                        }
                    }
                }
            }
        }
        context.registerReceiver(receiver, IntentFilter().apply {
            addAction(WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION)
            addAction(WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION)
            addAction(WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION)
        })
    }
}
