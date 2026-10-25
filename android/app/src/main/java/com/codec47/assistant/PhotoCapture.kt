package com.codec47.assistant

import android.annotation.SuppressLint
import android.content.ContentValues
import android.content.Context
import android.graphics.ImageFormat
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.provider.MediaStore
import java.util.concurrent.atomic.AtomicBoolean

/** Toma una foto sin abrir ninguna pantalla (Camera2) y la guarda en Imágenes/CODEC47. */
object PhotoCapture {
    @SuppressLint("MissingPermission")
    fun take(ctx: Context, front: Boolean, done: (Result<String>) -> Unit) {
        val thread = HandlerThread("codec47-cam").apply { start() }
        val h = Handler(thread.looper)
        val cm = ctx.getSystemService(CameraManager::class.java)
        val wanted = if (front) CameraCharacteristics.LENS_FACING_FRONT else CameraCharacteristics.LENS_FACING_BACK
        val id = cm.cameraIdList.firstOrNull { cm.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING) == wanted }
            ?: cm.cameraIdList.firstOrNull()
            ?: return done(Result.failure(Exception("No hay cámara")))
        val chars = cm.getCameraCharacteristics(id)
        val size = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)!!
            .getOutputSizes(ImageFormat.JPEG).maxBy { it.width.toLong() * it.height }
        val orientation = chars.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 90
        val reader = ImageReader.newInstance(size.width, size.height, ImageFormat.JPEG, 3)

        val finished = AtomicBoolean(false)
        val capturing = AtomicBoolean(false)
        var camera: CameraDevice? = null

        fun finish(r: Result<String>) {
            if (!finished.compareAndSet(false, true)) return
            h.post {
                try { camera?.close() } catch (_: Exception) {}
                reader.close()
                thread.quitSafely()
            }
            done(r)
        }

        reader.setOnImageAvailableListener({ r ->
            val img = r.acquireLatestImage() ?: return@setOnImageAvailableListener
            try {
                if (!capturing.get()) return@setOnImageAvailableListener // fotogramas de calentamiento
                val buf = img.planes[0].buffer
                val bytes = ByteArray(buf.remaining()).also { buf.get(it) }
                val values = ContentValues().apply {
                    put(MediaStore.Images.Media.DISPLAY_NAME, "CODEC47_${System.currentTimeMillis()}.jpg")
                    put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg")
                    put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/CODEC47")
                }
                val uri = ctx.contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
                    ?: throw Exception("No pude guardar la foto")
                ctx.contentResolver.openOutputStream(uri)!!.use { it.write(bytes) }
                finish(Result.success("Foto guardada en Imágenes/CODEC47"))
            } catch (e: Exception) {
                finish(Result.failure(e))
            } finally {
                img.close()
            }
        }, h)

        try {
            cm.openCamera(id, object : CameraDevice.StateCallback() {
                override fun onOpened(cam: CameraDevice) {
                    camera = cam
                    @Suppress("DEPRECATION")
                    cam.createCaptureSession(listOf(reader.surface), object : CameraCaptureSession.StateCallback() {
                        override fun onConfigured(s: CameraCaptureSession) {
                            // Unos instantes de "previsualización" para que la exposición se ajuste
                            val warm = cam.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply {
                                addTarget(reader.surface)
                                set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO)
                            }.build()
                            s.setRepeatingRequest(warm, null, h)
                            h.postAtTime({
                                try {
                                    s.stopRepeating()
                                    capturing.set(true)
                                    val still = cam.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE).apply {
                                        addTarget(reader.surface)
                                        set(CaptureRequest.JPEG_ORIENTATION, orientation)
                                        set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO)
                                    }.build()
                                    s.capture(still, null, h)
                                } catch (e: Exception) {
                                    finish(Result.failure(e))
                                }
                            }, SystemClock.uptimeMillis() + 1500)
                            h.postDelayed({ finish(Result.failure(Exception("La cámara tardó demasiado"))) }, 10_000)
                        }

                        override fun onConfigureFailed(s: CameraCaptureSession) =
                            finish(Result.failure(Exception("No pude configurar la cámara")))
                    }, h)
                }

                override fun onDisconnected(cam: CameraDevice) = finish(Result.failure(Exception("Cámara desconectada")))
                override fun onError(cam: CameraDevice, error: Int) =
                    finish(Result.failure(Exception("Error de cámara $error (¿la usa otra app?)")))
            }, h)
        } catch (e: Exception) {
            finish(Result.failure(e))
        }
    }
}
