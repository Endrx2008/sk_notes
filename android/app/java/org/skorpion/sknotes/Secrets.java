// sk_notes for Android. Copyright (C) 2026 Enrico Miot. SPDX-License-Identifier: GPL-3.0-or-later
package org.skorpion.sknotes;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Small secrets of the app (the password or access token of the Git sync), one file each in the
 * app's private folder "secrets". The text is encrypted (AES-256-GCM) with a key that lives in the
 * Android Keystore and never leaves it: a copy of the files alone is useless.
 *
 * If the Keystore of a device does not work, the secret is still kept, unencrypted, in the same
 * private folder (which other apps cannot read), and a warning is logged once.
 */
final class Secrets {
    private static final String TAG = "sk_notes";
    private static final String KEY_ALIAS = "sk_notes.secrets";
    private static final String ENC = "v1:";
    private static final String PLAIN = "p1:";
    private static boolean warned;

    private Secrets() {}

    private static File file(Context ctx, String name) throws NativeError {
        if (name == null || !name.matches("[A-Za-z0-9._-]{1,80}") || name.startsWith(".")) throw new NativeError("EINVAL", "secret name");
        File dir = new File(ctx.getFilesDir(), "secrets");
        if (!dir.isDirectory() && !dir.mkdirs()) throw new NativeError("EIO", "secrets folder");
        return new File(dir, name);
    }

    private static SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(KEY_ALIAS)) return (SecretKey) ks.getKey(KEY_ALIAS, null);
        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        gen.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return gen.generateKey();
    }

    static void set(Context ctx, String name, String value) throws NativeError {
        File f = file(ctx, name);
        byte[] data = String.valueOf(value).getBytes(StandardCharsets.UTF_8);
        String stored;
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, key());
            byte[] iv = c.getIV();
            byte[] enc = c.doFinal(data);
            stored = ENC + Base64.encodeToString(iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(enc, Base64.NO_WRAP);
        } catch (Exception e) {
            if (!warned) {
                warned = true;
                Log.w(TAG, "the Android Keystore is not usable: secrets are kept in the app's private folder without encryption", e);
            }
            stored = PLAIN + Base64.encodeToString(data, Base64.NO_WRAP);
        }
        Fs.writeAtomic(f.getPath(), stored.getBytes(StandardCharsets.UTF_8), 0);
    }

    /** The secret, or null when there is none (or it can no longer be read: the user signs in again). */
    static String get(Context ctx, String name) throws NativeError {
        File f = file(ctx, name);
        if (!f.isFile()) return null;
        String stored = new String(Fs.readBytes(f.getPath(), 1 << 20), StandardCharsets.UTF_8).trim();
        try {
            if (stored.startsWith(PLAIN)) return new String(Base64.decode(stored.substring(PLAIN.length()), Base64.DEFAULT), StandardCharsets.UTF_8);
            if (!stored.startsWith(ENC)) return null;
            String[] parts = stored.substring(ENC.length()).split(":");
            if (parts.length != 2) return null;
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.DEFAULT)));
            return new String(c.doFinal(Base64.decode(parts[1], Base64.DEFAULT)), StandardCharsets.UTF_8);
        } catch (Exception e) {
            Log.w(TAG, "a stored secret could not be read", e);
            return null;
        }
    }

    static boolean delete(Context ctx, String name) throws NativeError {
        File f = file(ctx, name);
        return f.isFile() && f.delete();
    }
}
