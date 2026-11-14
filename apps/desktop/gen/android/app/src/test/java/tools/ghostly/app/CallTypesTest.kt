package tools.ghostly.app

import android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
import android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MANIFEST
import android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CallTypesTest {
  @Test
  fun aVoiceCallKeepsTheMicrophone() {
    assertEquals(FOREGROUND_SERVICE_TYPE_MICROPHONE, CallTypes.of(35, microphone = true, camera = true, video = false))
    assertEquals(FOREGROUND_SERVICE_TYPE_MICROPHONE, CallTypes.of(30, microphone = true, camera = false, video = false))
  }

  @Test
  fun aCallSendingTheCameraKeepsTheCameraToo() {
    assertEquals(FOREGROUND_SERVICE_TYPE_MICROPHONE or FOREGROUND_SERVICE_TYPE_CAMERA, CallTypes.of(35, microphone = true, camera = true, video = true))
  }

  @Test
  fun aCameraNotAllowedIsNeverAsked() {
    // Android 14 and up end the app for a camera service without the camera's permission.
    assertEquals(FOREGROUND_SERVICE_TYPE_MICROPHONE, CallTypes.of(35, microphone = true, camera = false, video = true))
  }

  @Test
  fun noMicrophoneAllowedStartsNothing() {
    assertNull(CallTypes.of(35, microphone = false, camera = true, video = true))
    assertNull(CallTypes.of(30, microphone = false, camera = false, video = false))
  }

  @Test
  fun beforeAndroid11TheManifestsTypes() {
    assertEquals(FOREGROUND_SERVICE_TYPE_MANIFEST, CallTypes.of(29, microphone = true, camera = true, video = true))
    assertEquals(FOREGROUND_SERVICE_TYPE_MANIFEST, CallTypes.of(26, microphone = false, camera = false, video = false))
  }
}
