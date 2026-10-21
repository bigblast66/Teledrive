package com.bigblast66.telegramdrive

import android.Manifest
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Log
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

data class CachedFileEntry(
    val uri: String,
    val cachedPath: String,
    val fileName: String,
    val fileSize: Long
)

class MainActivity : TauriActivity() {

    companion object {
        private const val TAG = "TeledriveMainActivity"
        private const val PERMISSION_REQUEST_CODE = 2001

        @Volatile
        var instance: MainActivity? = null
        @Volatile
        var appContext: android.content.Context? = null

        val uriCacheMap = ConcurrentHashMap<String, CachedFileEntry>()
        val pendingShareCount = AtomicInteger(0)

        @JvmStatic
        fun requestStoragePermissions() {
            instance?.let { act ->
                act.runOnUiThread {
                    act.checkAndRequestPermissions()
                }
            }
        }

        @JvmStatic
        fun getCachedPath(uriStr: String): String? {
            val entry = uriCacheMap[uriStr]
            if (entry != null) {
                val f = File(entry.cachedPath)
                if (f.exists() && f.length() > 0) {
                    return entry.cachedPath
                }
            }
            return null
        }

        @JvmStatic
        fun getLocalFileFromUri(uriStr: String): String? {
            val act = instance ?: return null
            // If already on main thread, cache directly; otherwise dispatch to main thread and wait
            if (Looper.myLooper() == Looper.getMainLooper()) {
                return act.cacheUriInternal(uriStr)
            } else {
                var result: String? = null
                val latch = CountDownLatch(1)
                Handler(Looper.getMainLooper()).post {
                    try {
                        result = act.cacheUriInternal(uriStr)
                    } finally {
                        latch.countDown()
                    }
                }
                latch.await(15, TimeUnit.SECONDS)
                return result
            }
        }

        @JvmStatic
        fun saveFileToPublicDownloads(cachePath: String, fileName: String, mimeType: String): Boolean {
            val context = instance ?: appContext ?: return false
            val cacheFile = File(cachePath)
            if (!cacheFile.exists() || cacheFile.length() == 0L) {
                Log.e(TAG, "Cache file does not exist or is empty: $cachePath")
                return false
            }

            try {
                val safeMime = if (mimeType.isBlank()) "application/octet-stream" else mimeType
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    val contentValues = ContentValues().apply {
                        put(MediaStore.MediaColumns.DISPLAY_NAME, fileName)
                        put(MediaStore.MediaColumns.MIME_TYPE, safeMime)
                        put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                        put(MediaStore.MediaColumns.IS_PENDING, 1)
                    }

                    val resolver = context.contentResolver
                    val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, contentValues)
                        ?: return false

                    resolver.openOutputStream(uri)?.use { outStream ->
                        FileInputStream(cacheFile).use { inStream ->
                            inStream.copyTo(outStream)
                        }
                        outStream.flush()
                    } ?: return false

                    contentValues.clear()
                    contentValues.put(MediaStore.MediaColumns.IS_PENDING, 0)
                    resolver.update(uri, contentValues, null, null)
                    Log.i(TAG, "Saved to MediaStore.Downloads: $fileName")
                    return true
                } else {
                    @Suppress("DEPRECATION")
                    val downloadsDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
                    if (!downloadsDir.exists()) downloadsDir.mkdirs()
                    val destFile = File(downloadsDir, fileName)
                    FileInputStream(cacheFile).use { inStream ->
                        FileOutputStream(destFile).use { outStream ->
                            inStream.copyTo(outStream)
                            outStream.flush()
                        }
                    }
                    MediaScannerConnection.scanFile(context, arrayOf(destFile.absolutePath), arrayOf(safeMime), null)
                    Log.i(TAG, "Saved legacy downloads file: ${destFile.absolutePath}")
                    return true
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to save file to public downloads: ${e.message}", e)
                return false
            }
        }

        @JvmStatic
        fun openFileExternally(path: String, mimeType: String): Boolean {
            val context = instance ?: appContext ?: return false
            return try {
                val uri: Uri = if (path.startsWith("http://") || path.startsWith("https://")) {
                    Uri.parse(path)
                } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                    val file = File(path)
                    FileProvider.getUriForFile(
                        context,
                        "${context.packageName}.fileprovider",
                        file
                    )
                } else {
                    val file = File(path)
                    Uri.fromFile(file)
                }

                val safeMime = if (mimeType.isBlank()) "*/*" else mimeType
                val intent = Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(uri, safeMime)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(intent)
                true
            } catch (e: Exception) {
                Log.e(TAG, "Failed to open file externally: ${e.message}", e)
                false
            }
        }

        @JvmStatic
        fun extractVideoThumbnail(path: String): ByteArray? {
            val retriever = android.media.MediaMetadataRetriever()
            return try {
                retriever.setDataSource(path)
                val bitmap = retriever.getFrameAtTime(1000000, android.media.MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
                    ?: retriever.frameAtTime
                if (bitmap != null) {
                    val stream = java.io.ByteArrayOutputStream()
                    val maxDim = Math.max(bitmap.width, bitmap.height)
                    val scale = if (maxDim > 360) 360f / maxDim else 1f
                    val scaled = if (scale < 1f) {
                        android.graphics.Bitmap.createScaledBitmap(
                            bitmap,
                            (bitmap.width * scale).toInt(),
                            (bitmap.height * scale).toInt(),
                            true
                        )
                    } else {
                        bitmap
                    }
                    scaled.compress(android.graphics.Bitmap.CompressFormat.JPEG, 80, stream)
                    stream.toByteArray()
                } else {
                    null
                }
            } catch (e: Exception) {
                Log.w(TAG, "Failed to extract video thumbnail: ${e.message}")
                null
            } finally {
                try {
                    retriever.release()
                } catch (_: Exception) {}
            }
        }

        @JvmStatic
        fun getAndClearShareCount(): Int {
            return pendingShareCount.getAndSet(0)
        }

        @JvmStatic
        fun listCachedFiles(): String {
            val list = JSONArray()
            for ((_, entry) in uriCacheMap) {
                if (File(entry.cachedPath).exists()) {
                    val obj = JSONObject().apply {
                        put("uri", entry.uri)
                        put("cached_path", entry.cachedPath)
                        put("file_name", entry.fileName)
                        put("file_size", entry.fileSize)
                    }
                    list.put(obj)
                }
            }
            return list.toString()
        }

        @JvmStatic
        fun removeCachedPath(uri: String) {
            uriCacheMap.remove(uri)?.let { entry ->
                try {
                    File(entry.cachedPath).delete()
                } catch (_: Exception) {}
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        instance = this
        appContext = applicationContext
        enableEdgeToEdge()
        handleShareIntent(intent)
        checkAndRequestPermissions()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == PERMISSION_REQUEST_CODE) {
            for (i in permissions.indices) {
                val granted = grantResults.getOrNull(i) == PackageManager.PERMISSION_GRANTED
                Log.i(TAG, "Permission ${permissions[i]}: ${if (granted) "GRANTED" else "DENIED"}")
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleShareIntent(intent)
    }

    override fun onDestroy() {
        super.onDestroy()
        if (instance == this) {
            instance = null
        }
    }

    fun checkAndRequestPermissions() {
        val permissionsToRequest = mutableListOf<String>()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_MEDIA_IMAGES) != PackageManager.PERMISSION_GRANTED) {
                permissionsToRequest.add(Manifest.permission.READ_MEDIA_IMAGES)
            }
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_MEDIA_VIDEO) != PackageManager.PERMISSION_GRANTED) {
                permissionsToRequest.add(Manifest.permission.READ_MEDIA_VIDEO)
            }
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_MEDIA_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                permissionsToRequest.add(Manifest.permission.READ_MEDIA_AUDIO)
            }
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                permissionsToRequest.add(Manifest.permission.POST_NOTIFICATIONS)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) != PackageManager.PERMISSION_GRANTED) {
                    permissionsToRequest.add(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)
                }
            }
        } else {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                permissionsToRequest.add(Manifest.permission.READ_EXTERNAL_STORAGE)
            }
            if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.Q &&
                ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                permissionsToRequest.add(Manifest.permission.WRITE_EXTERNAL_STORAGE)
            }
        }

        if (permissionsToRequest.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, permissionsToRequest.toTypedArray(), PERMISSION_REQUEST_CODE)
        }
    }

    private fun handleShareIntent(intent: Intent?) {
        if (intent == null) return
        val action = intent.action ?: return
        val type = intent.type ?: return

        when (action) {
            Intent.ACTION_SEND -> {
                val uri = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableExtra(Intent.EXTRA_STREAM)
                }
                uri?.let {
                    val path = cacheUriInternal(it.toString())
                    if (path != null) {
                        pendingShareCount.incrementAndGet()
                    }
                }
            }
            Intent.ACTION_SEND_MULTIPLE -> {
                val uris = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)
                }
                uris?.forEach { uri ->
                    val path = cacheUriInternal(uri.toString())
                    if (path != null) {
                        pendingShareCount.incrementAndGet()
                    }
                }
            }
        }
    }

    fun cacheUriInternal(uriStr: String): String? {
        try {
            val uri = Uri.parse(uriStr)
            val resolver = contentResolver

            var displayName = "upload_${System.currentTimeMillis()}"
            var fileSize = 0L

            if (uri.scheme == "content") {
                resolver.query(uri, null, null, null, null)?.use { cursor ->
                    val nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    val sizeIdx = cursor.getColumnIndex(OpenableColumns.SIZE)
                    if (cursor.moveToFirst()) {
                        if (nameIdx != -1) {
                            val name = cursor.getString(nameIdx)
                            if (!name.isNullOrBlank()) displayName = name
                        }
                        if (sizeIdx != -1) {
                            fileSize = cursor.getLong(sizeIdx)
                        }
                    }
                }
            } else if (uri.scheme == "file") {
                uri.path?.let { p ->
                    val f = File(p)
                    displayName = f.name
                    fileSize = f.length()
                }
            }

            // Sanitize file name
            displayName = displayName.replace(Regex("[/\\\\:*?\"<>|]"), "_")

            val cacheDir = File(cacheDir, "shared_uploads").apply { mkdirs() }
            val targetFile = File(cacheDir, displayName)

            resolver.openInputStream(uri)?.use { inStream ->
                FileOutputStream(targetFile).use { outStream ->
                    inStream.copyTo(outStream)
                    outStream.flush()
                }
            } ?: return null

            if (targetFile.exists() && targetFile.length() > 0) {
                val path = targetFile.absolutePath
                val finalSize = if (fileSize > 0) fileSize else targetFile.length()
                uriCacheMap[uriStr] = CachedFileEntry(uriStr, path, displayName, finalSize)
                Log.i(TAG, "Cached URI: $uriStr -> $path ($finalSize bytes)")
                return path
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to cache URI $uriStr: ${e.message}", e)
        }
        return null
    }
}
