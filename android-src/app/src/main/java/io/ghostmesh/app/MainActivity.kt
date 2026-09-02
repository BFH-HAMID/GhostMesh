package io.ghostmesh.app

import android.os.Bundle
import android.view.WindowManager
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        // Register custom plugins BEFORE super.onCreate so the bridge exposes them.
        registerPlugin(WifiDirectPlugin::class.java)
        registerPlugin(BlePeripheralPlugin::class.java)
        super.onCreate(savedInstanceState)

        // Stealth: block screenshots / recents thumbnail of chat content.
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
    }
}
