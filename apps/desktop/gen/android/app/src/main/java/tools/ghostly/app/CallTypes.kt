package tools.ghostly.app

import android.content.pm.ServiceInfo

/**
 * The foreground-service types the call service (CallService.kt) runs with. Android 11 and up let an app out of sight
 * use the microphone (or the camera) only from a foreground service of that type, and Android 14 and up start one of
 * those types only once its permission is granted (else SecurityException, and the app ends). So: the microphone when
 * the person allowed it, and the camera too while the call sends its picture and the camera is allowed. Null when
 * there is nothing to start: no microphone allowed, so no call that the service would keep going. Below Android 11
 * any foreground service keeps the microphone: the manifest's types. Plain Kotlin, so a JVM unit test reads it.
 */
object CallTypes {
  fun of(sdk: Int, microphone: Boolean, camera: Boolean, video: Boolean): Int? {
    if (sdk < 30) return ServiceInfo.FOREGROUND_SERVICE_TYPE_MANIFEST
    if (!microphone) return null
    var types = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
    if (video && camera) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
    return types
  }
}
