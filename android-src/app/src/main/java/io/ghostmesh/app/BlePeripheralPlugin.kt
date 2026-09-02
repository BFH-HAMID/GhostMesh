package io.ghostmesh.app

import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.content.Context
import android.os.ParcelUuid
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.UUID

/**
 * GhostMeshBlePeripheral — the *server* half of the BLE link.
 *
 * `@capacitor-community/bluetooth-le` only implements the GATT central role,
 * so each device also advertises a GhostMesh GATT service so other centrals
 * can discover and connect to it. UUIDs must match src/mesh/transports/BleTransport.ts.
 *
 * Characteristics:
 *   ADVERT  read/write  — JSON PeerAdvert (public keys only)
 *   INBOX   write-no-rsp — inbound frames [seq][total][data]
 *   OUTBOX  notify       — outbound frames
 */
@CapacitorPlugin(name = "GhostMeshBlePeripheral")
class BlePeripheralPlugin : Plugin() {

    companion object {
        val SERVICE: UUID = UUID.fromString("0000a1b2-0000-1000-8000-00805f9b34fb")
        val ADVERT: UUID = UUID.fromString("0000a1b3-0000-1000-8000-00805f9b34fb")
        val INBOX: UUID = UUID.fromString("0000a1b4-0000-1000-8000-00805f9b34fb")
        val OUTBOX: UUID = UUID.fromString("0000a1b5-0000-1000-8000-00805f9b34fb")
    }

    private var advertJson: ByteArray = "{}".toByteArray()

    @PluginMethod
    fun startAdvertising(call: PluginCall) {
        advertJson = (call.getString("advert") ?: "{}").toByteArray()
        val bt = context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
        val adapter = bt.adapter ?: return call.reject("no bluetooth adapter")
        val advertiser = adapter.bluetoothLeAdvertiser ?: return call.reject("BLE advertising unsupported")

        val service = BluetoothGattService(SERVICE, BluetoothGattService.SERVICE_TYPE_PRIMARY).apply {
            addCharacteristic(BluetoothGattCharacteristic(ADVERT,
                BluetoothGattCharacteristic.PROPERTY_READ or BluetoothGattCharacteristic.PROPERTY_WRITE,
                BluetoothGattCharacteristic.PERMISSION_READ or BluetoothGattCharacteristic.PERMISSION_WRITE))
            addCharacteristic(BluetoothGattCharacteristic(INBOX,
                BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
                BluetoothGattCharacteristic.PERMISSION_WRITE))
            addCharacteristic(BluetoothGattCharacteristic(OUTBOX,
                BluetoothGattCharacteristic.PROPERTY_NOTIFY,
                BluetoothGattCharacteristic.PERMISSION_READ))
        }
        // TODO: open BluetoothGattServer via bt.openGattServer(context, callback), addService(service),
        //       serve ADVERT reads with advertJson, forward INBOX writes to JS via notifyListeners("frame", ...),
        //       and push OUTBOX notifications from the `send` method below.

        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_BALANCED)
            .setConnectable(true)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
            .build()
        val data = AdvertiseData.Builder().addServiceUuid(ParcelUuid(SERVICE)).setIncludeDeviceName(false).build()
        advertiser.startAdvertising(settings, data, object : android.bluetooth.le.AdvertiseCallback() {
            override fun onStartSuccess(s: AdvertiseSettings?) { call.resolve() }
            override fun onStartFailure(errorCode: Int) { call.reject("advertise failed: $errorCode") }
        })
        service.hashCode() // keep reference in real impl
    }

    @PluginMethod
    fun stopAdvertising(call: PluginCall) { call.resolve() }

    @PluginMethod
    fun send(call: PluginCall) {
        // Notify OUTBOX on the connected central identified by deviceId
        call.resolve(JSObject().put("bytes", (call.getString("data") ?: "").length))
    }
}
