package io.github.grendel116.sanctuary;

import android.content.ContentValues;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Map;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "SanctuaryNativeStore")
public class SanctuaryNativeStorePlugin extends Plugin {
    private static final String KEYSTORE_PROVIDER = "AndroidKeyStore";
    private static final String MASTER_KEY_ALIAS = "lm_sanctuary_vault_key";
    private static final String PREFS_NAME = "lm_sanctuary_keystore_prefs";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final int GCM_TAG_BITS = 128;

    private SocialDbHelper dbHelper;

    @Override
    public void load() {
        super.load();
        dbHelper = new SocialDbHelper(getContext());
    }

    private SecretKey getOrCreateKey() throws Exception {
        KeyStore ks = KeyStore.getInstance(KEYSTORE_PROVIDER);
        ks.load(null);
        if (ks.containsAlias(MASTER_KEY_ALIAS)) {
            KeyStore.SecretKeyEntry entry = (KeyStore.SecretKeyEntry) ks.getEntry(MASTER_KEY_ALIAS, null);
            if (entry != null) {
                return entry.getSecretKey();
            }
        }
        KeyGenerator keyGenerator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE_PROVIDER);
        KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(
                MASTER_KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build();
        keyGenerator.init(spec);
        return keyGenerator.generateKey();
    }

    private SharedPreferences secretPrefs() {
        return getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    @PluginMethod
    public void setSecret(PluginCall call) {
        String key = call.getString("key");
        String valueJson = call.getString("value", "{}");
        if (key == null || key.isEmpty()) {
            call.reject("Secret key is required");
            return;
        }
        try {
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
            byte[] iv = cipher.getIV();
            byte[] ct = cipher.doFinal(valueJson.getBytes(StandardCharsets.UTF_8));
            JSObject rec = new JSObject();
            rec.put("iv", Base64.encodeToString(iv, Base64.NO_WRAP));
            rec.put("ct", Base64.encodeToString(ct, Base64.NO_WRAP));
            secretPrefs().edit().putString(key, rec.toString()).apply();
            call.resolve();
        } catch (Exception e) {
            call.reject("AndroidKeyStore encryption failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void getSecret(PluginCall call) {
        String key = call.getString("key");
        if (key == null || key.isEmpty()) {
            call.resolve(new JSObject().put("value", (Object) null));
            return;
        }
        String raw = secretPrefs().getString(key, null);
        if (raw == null) {
            call.resolve(new JSObject().put("value", (Object) null));
            return;
        }
        try {
            JSObject rec = new JSObject(raw);
            byte[] iv = Base64.decode(rec.getString("iv"), Base64.NO_WRAP);
            byte[] ct = Base64.decode(rec.getString("ct"), Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(GCM_TAG_BITS, iv));
            String pt = new String(cipher.doFinal(ct), StandardCharsets.UTF_8);
            call.resolve(new JSObject().put("value", pt));
        } catch (Exception e) {
            call.reject("AndroidKeyStore decryption failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void deleteSecret(PluginCall call) {
        String key = call.getString("key");
        if (key != null && !key.isEmpty()) {
            secretPrefs().edit().remove(key).apply();
        }
        call.resolve();
    }

    @PluginMethod
    public void listSecretIds(PluginCall call) {
        JSArray ids = new JSArray();
        Map<String, ?> all = secretPrefs().getAll();
        for (String k : all.keySet()) {
            ids.put(k);
        }
        call.resolve(new JSObject().put("ids", ids));
    }

    @PluginMethod
    public void kvGet(PluginCall call) {
        String store = call.getString("storeName", "kv");
        String key = call.getString("key", "");
        SQLiteDatabase db = dbHelper.getReadableDatabase();
        try (Cursor c = db.rawQuery(
                "SELECT value_json FROM kv_store WHERE store_name = ? AND key = ?",
                new String[]{store, key}
        )) {
            if (c.moveToFirst()) {
                call.resolve(new JSObject().put("value", c.getString(0)));
            } else {
                call.resolve(new JSObject().put("value", (Object) null));
            }
        }
    }

    @PluginMethod
    public void kvPut(PluginCall call) {
        String store = call.getString("storeName", "kv");
        String key = call.getString("key", "");
        String valueJson = call.getString("value", "null");
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        ContentValues cv = new ContentValues();
        cv.put("store_name", store);
        cv.put("key", key);
        cv.put("value_json", valueJson);
        cv.put("updated_at", System.currentTimeMillis() / 1000.0);
        db.insertWithOnConflict("kv_store", null, cv, SQLiteDatabase.CONFLICT_REPLACE);
        call.resolve();
    }

    @PluginMethod
    public void kvDelete(PluginCall call) {
        String store = call.getString("storeName", "kv");
        String key = call.getString("key", "");
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        db.delete("kv_store", "store_name = ? AND key = ?", new String[]{store, key});
        call.resolve();
    }

    @PluginMethod
    public void kvGetAll(PluginCall call) {
        String store = call.getString("storeName", "kv");
        SQLiteDatabase db = dbHelper.getReadableDatabase();
        JSArray entries = new JSArray();
        try (Cursor c = db.rawQuery(
                "SELECT key, value_json FROM kv_store WHERE store_name = ? ORDER BY updated_at ASC",
                new String[]{store}
        )) {
            while (c.moveToNext()) {
                JSObject row = new JSObject();
                row.put("key", c.getString(0));
                row.put("value", c.getString(1));
                entries.put(row);
            }
        }
        call.resolve(new JSObject().put("entries", entries));
    }

    @PluginMethod
    public void kvClear(PluginCall call) {
        String store = call.getString("storeName", "kv");
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        db.delete("kv_store", "store_name = ?", new String[]{store});
        call.resolve();
    }

    @PluginMethod
    public void saveLinkedPost(PluginCall call) {
        String canonicalId = call.getString("canonicalId", "");
        if (canonicalId.isEmpty()) {
            call.reject("canonicalId is required");
            return;
        }
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        ContentValues cv = new ContentValues();
        cv.put("canonical_id", canonicalId);
        cv.put("mastodon_status_id", call.getString("mastodonStatusId", ""));
        cv.put("mastodon_instance", call.getString("mastodonInstance", ""));
        cv.put("bluesky_uri", call.getString("blueskyUri", ""));
        cv.put("bluesky_cid", call.getString("blueskyCid", ""));
        cv.put("threads_post_id", call.getString("threadsPostId", ""));
        cv.put("parent_canonical_id", call.getString("parentCanonicalId", ""));
        cv.put("created_at", System.currentTimeMillis() / 1000.0);
        db.insertWithOnConflict("linked_posts", null, cv, SQLiteDatabase.CONFLICT_REPLACE);
        call.resolve();
    }

    @PluginMethod
    public void findLinkedPost(PluginCall call) {
        String anyId = call.getString("id", "");
        SQLiteDatabase db = dbHelper.getReadableDatabase();
        try (Cursor c = db.rawQuery(
                "SELECT canonical_id, mastodon_status_id, mastodon_instance, bluesky_uri, bluesky_cid, threads_post_id, parent_canonical_id "
                        + "FROM linked_posts WHERE canonical_id = ? OR mastodon_status_id = ? OR bluesky_uri = ? OR threads_post_id = ? LIMIT 1",
                new String[]{anyId, anyId, anyId, anyId}
        )) {
            if (c.moveToFirst()) {
                JSObject out = new JSObject();
                out.put("canonical_id", c.getString(0));
                out.put("mastodonStatusId", c.getString(1));
                out.put("mastodonInstance", c.getString(2));
                out.put("blueskyUri", c.getString(3));
                out.put("blueskyCid", c.getString(4));
                out.put("threadsPostId", c.getString(5));
                out.put("parentCanonicalId", c.getString(6));
                call.resolve(new JSObject().put("record", out));
            } else {
                call.resolve(new JSObject().put("record", (Object) null));
            }
        }
    }

    @PluginMethod
    public void deleteLinkedPost(PluginCall call) {
        String anyId = call.getString("id", "");
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        db.delete(
                "linked_posts",
                "canonical_id = ? OR mastodon_status_id = ? OR bluesky_uri = ? OR threads_post_id = ? OR parent_canonical_id = ?",
                new String[]{anyId, anyId, anyId, anyId, anyId}
        );
        call.resolve();
    }

    private static class SocialDbHelper extends SQLiteOpenHelper {
        private static final String DB_NAME = "sanctuary_social.db";
        private static final int DB_VERSION = 1;

        SocialDbHelper(Context ctx) {
            super(ctx, DB_NAME, null, DB_VERSION);
        }

        @Override
        public void onConfigure(SQLiteDatabase db) {
            super.onConfigure(db);
            db.enableWriteAheadLogging();
        }

        @Override
        public void onCreate(SQLiteDatabase db) {
            db.execSQL(
                    "CREATE TABLE IF NOT EXISTS kv_store ("
                            + "store_name TEXT NOT NULL, "
                            + "key TEXT NOT NULL, "
                            + "value_json TEXT NOT NULL, "
                            + "updated_at REAL NOT NULL, "
                            + "PRIMARY KEY (store_name, key))"
            );
            db.execSQL(
                    "CREATE TABLE IF NOT EXISTS linked_posts ("
                            + "canonical_id TEXT PRIMARY KEY, "
                            + "mastodon_status_id TEXT DEFAULT '', "
                            + "mastodon_instance TEXT DEFAULT '', "
                            + "bluesky_uri TEXT DEFAULT '', "
                            + "bluesky_cid TEXT DEFAULT '', "
                            + "threads_post_id TEXT DEFAULT '', "
                            + "parent_canonical_id TEXT DEFAULT '', "
                            + "created_at REAL NOT NULL)"
            );
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_linked_masto ON linked_posts (mastodon_status_id)");
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_linked_bsky ON linked_posts (bluesky_uri)");
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_linked_threads ON linked_posts (threads_post_id)");
        }

        @Override
        public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
            onCreate(db);
        }
    }
}
