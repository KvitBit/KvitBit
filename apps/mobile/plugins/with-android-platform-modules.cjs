"use strict";
// Expo config plugin: installs Kvitbit's Android native modules for:
// 1. Material You (Monet) dynamic color resolution on API 31+ (reads real ARGB ints via ContextCompat.getColor)
// 2. Android Share Sheet (ACTION_SEND / ACTION_SEND_MULTIPLE) receipt intake for image/* and application/pdf.
const fs = require("node:fs");
const path = require("node:path");
const { withDangerousMod, withMainApplication, withMainActivity } = require("expo/config-plugins");

const DYNAMIC_COLOR_MODULE_KT = `package cz.kvitbit.app

import android.os.Build
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class KvitbitDynamicColorModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "KvitbitDynamicColor"

  @ReactMethod
  fun getDynamicPalette(promise: Promise) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
      promise.resolve(null)
      return
    }
    try {
      val map = Arguments.createMap()
      val resources = mapOf(
        "system_accent1_600" to android.R.color.system_accent1_600,
        "system_accent1_200" to android.R.color.system_accent1_200,
        "system_accent1_500" to android.R.color.system_accent1_500,
        "system_accent2_600" to android.R.color.system_accent2_600,
        "system_accent2_200" to android.R.color.system_accent2_200,
        "system_accent3_600" to android.R.color.system_accent3_600,
        "system_accent3_200" to android.R.color.system_accent3_200,
        "system_neutral1_10" to android.R.color.system_neutral1_10,
        "system_neutral1_900" to android.R.color.system_neutral1_900
      )
      for ((key, resId) in resources) {
        map.putInt(key, ContextCompat.getColor(reactContext, resId))
      }
      promise.resolve(map)
    } catch (err: Throwable) {
      promise.resolve(null)
    }
  }
}
`;

const SHARE_INTENT_MODULE_KT = `package cz.kvitbit.app

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import java.util.concurrent.Executors
import org.json.JSONObject

data class SharedReceiptItem(
  val uri: String,
  val filename: String,
  val mimeType: String,
  val sizeBytes: Long
)

object KvitbitShareInbox {
  private const val MAX_FILE_BYTES = 20L * 1024L * 1024L
  private val executor = Executors.newSingleThreadExecutor()
  @Volatile var listener: (() -> Unit)? = null

  private fun directory(context: Context) =
    File(context.filesDir, "kvitbit-shared-receipts").apply { mkdirs() }

  fun handleIntent(context: Context, intent: Intent?) {
    if (intent == null) return
    val action = intent.action ?: return
    if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return
    val uris = mutableListOf<Uri>()
    if (action == Intent.ACTION_SEND) {
      val single = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
      } else {
        @Suppress("DEPRECATION")
        intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
      }
      if (single != null) uris.add(single)
    } else {
      val multiple = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
      } else {
        @Suppress("DEPRECATION")
        intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)
      }
      if (multiple != null) uris.addAll(multiple)
    }
    val clip = intent.clipData
    if (uris.isEmpty() && clip != null) {
      for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let(uris::add)
    }
    if (uris.isEmpty()) return
    intent.removeExtra(Intent.EXTRA_STREAM)
    intent.clipData = null

    val app = context.applicationContext
    val fallbackType = intent.type
    executor.execute {
      val root = directory(app)
      for (uri in uris.distinct()) {
        if (uri.scheme != "content") continue
        val id = UUID.randomUUID().toString()
        val staging = File(root, "." + id)
        try {
          val mimeType = app.contentResolver.getType(uri) ?: fallbackType ?: continue
          if (!mimeType.startsWith("image/") && mimeType != "application/pdf") continue
          val filename = resolveFilename(app, uri, mimeType)
          check(staging.mkdir())
          val file = File(staging, "receipt")
          val input = app.contentResolver.openInputStream(uri) ?: continue
          input.use {
            FileOutputStream(file).use { output ->
              val buffer = ByteArray(8192)
              var size = 0L
              while (true) {
                val count = input.read(buffer)
                if (count == -1) break
                size += count
                check(size <= MAX_FILE_BYTES)
                output.write(buffer, 0, count)
              }
              output.fd.sync()
            }
          }
          check(file.length() > 0)
          FileOutputStream(File(staging, "metadata.json")).use { output ->
            output.write(JSONObject().put("filename", filename)
              .put("mimeType", mimeType).toString().toByteArray())
            output.fd.sync()
          }
          check(staging.renameTo(File(root, id)))
        } catch (_: Exception) {
          // A revoked or oversized share must leave the other files available.
        } finally {
          staging.deleteRecursively()
        }
      }
      listener?.invoke()
    }
  }

  private fun resolveFilename(context: Context, uri: Uri, mimeType: String): String {
    context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
      if (cursor.moveToFirst()) {
        val idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        if (idx >= 0) {
          val name = cursor.getString(idx)
          if (!name.isNullOrBlank()) return name
        }
      }
    }
    val ext = when (mimeType) {
      "application/pdf" -> "pdf"
      "image/png" -> "png"
      "image/webp" -> "webp"
      else -> "jpg"
    }
    return "shared-receipt.$ext"
  }

  private fun entries(context: Context) =
    directory(context).listFiles()?.filter { it.isDirectory && !it.name.startsWith(".") }.orEmpty()

  fun list(context: Context): List<SharedReceiptItem> = entries(context).mapNotNull { dir ->
    try {
      val file = File(dir, "receipt")
      val meta = JSONObject(File(dir, "metadata.json").readText())
      SharedReceiptItem(Uri.fromFile(file).toString(), meta.getString("filename"),
        meta.getString("mimeType"), file.length())
    } catch (_: Exception) {
      null
    }
  }

  fun acknowledge(context: Context, uris: Set<String>) {
    for (dir in entries(context)) {
      if (Uri.fromFile(File(dir, "receipt")).toString() in uris) dir.deleteRecursively()
    }
  }
}

class KvitbitShareIntentModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "KvitbitShareIntent"

  override fun initialize() {
    super.initialize()
    KvitbitShareInbox.listener = {
      if (reactContext.hasActiveReactInstance()) {
        reactContext
          .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          .emit("KvitbitSharedReceipts", null)
      }
    }
  }

  override fun invalidate() {
    KvitbitShareInbox.listener = null
    super.invalidate()
  }

  @ReactMethod
  fun listPendingSharedFiles(promise: Promise) {
    val items = KvitbitShareInbox.list(reactContext)
    val array = Arguments.createArray()
    for (item in items) {
      val map = Arguments.createMap()
      map.putString("uri", item.uri)
      map.putString("filename", item.filename)
      map.putString("mimeType", item.mimeType)
      map.putDouble("sizeBytes", item.sizeBytes.toDouble())
      array.pushMap(map)
    }
    promise.resolve(array)
  }

  @ReactMethod
  fun acknowledgeSharedFiles(uris: ReadableArray, promise: Promise) {
    val acknowledged = (0 until uris.size()).mapNotNull { uris.getString(it) }.toSet()
    KvitbitShareInbox.acknowledge(reactContext, acknowledged)
    promise.resolve(null)
  }
}
`;

const PLATFORM_PACKAGE_KT = `package cz.kvitbit.app

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class KvitbitPlatformPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(
      KvitbitDynamicColorModule(reactContext),
      KvitbitShareIntentModule(reactContext)
    )

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
`;

const packageListBlock = /PackageList\(this\)\.packages\.apply\s*\{/;
const superOnCreate = /super\.onCreate\(([^)]*)\)/;
const trailingActivityBrace = /(\n\}\s*)$/;

function registerPlatformPackageInMainApplication(contents) {
  if (contents.includes("KvitbitPlatformPackage()")) return contents;
  return contents.replace(
    packageListBlock,
    "PackageList(this).packages.apply {\n              add(KvitbitPlatformPackage())",
  );
}

function wireShareIntentInMainActivity(contents) {
  let updated = contents;
  if (!updated.includes("KvitbitShareInbox.handleIntent")) {
    updated = updated.replace(
      superOnCreate,
      "super.onCreate($1)\n    KvitbitShareInbox.handleIntent(this, intent)",
    );
    if (!updated.includes("override fun onNewIntent")) {
      updated = updated.replace(
        trailingActivityBrace,
        "\n  override fun onNewIntent(intent: android.content.Intent) {\n    super.onNewIntent(intent)\n    setIntent(intent)\n    KvitbitShareInbox.handleIntent(this, intent)\n  }\n$1",
      );
    }
  }
  return updated;
}

const withAndroidPlatformModules = (config) => {
  const withGeneratedSources = withDangerousMod(config, [
    "android",
    (mod) => {
      const pkgDir = path.join(
        mod.modRequest.platformProjectRoot,
        "app/src/main/java/cz/kvitbit/app",
      );
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, "KvitbitDynamicColorModule.kt"), DYNAMIC_COLOR_MODULE_KT);
      fs.writeFileSync(path.join(pkgDir, "KvitbitShareIntentModule.kt"), SHARE_INTENT_MODULE_KT);
      fs.writeFileSync(path.join(pkgDir, "KvitbitPlatformPackage.kt"), PLATFORM_PACKAGE_KT);
      return mod;
    },
  ]);
  const withRegisteredPackage = withMainApplication(withGeneratedSources, (mod) => {
    mod.modResults.contents = registerPlatformPackageInMainApplication(mod.modResults.contents);
    return mod;
  });
  return withMainActivity(withRegisteredPackage, (mod) => {
    mod.modResults.contents = wireShareIntentInMainActivity(mod.modResults.contents);
    return mod;
  });
};

module.exports = withAndroidPlatformModules;
module.exports.registerPlatformPackageInMainApplication = registerPlatformPackageInMainApplication;
module.exports.wireShareIntentInMainActivity = wireShareIntentInMainActivity;
