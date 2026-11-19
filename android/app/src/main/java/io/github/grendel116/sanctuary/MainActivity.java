package io.github.grendel116.sanctuary;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SanctuaryNativeStorePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
