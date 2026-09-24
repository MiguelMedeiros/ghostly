// macOS requires its actual authorization state; the desktop plugin's generic
// permission API unconditionally returns Granted. No notification contains chat data.
#[tauri::command]
pub async fn native_notification_permission(request: bool) -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        mac::permission(request).await.map(Some)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = request;
        Ok(None)
    }
}

#[tauri::command]
pub async fn native_private_notification(id: String, body: String) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        if mac::permission(false).await? != "granted" {
            return Ok(true);
        }
        mac::show(&id, &body).await?;
        Ok(true)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (id, body);
        Ok(false)
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSError, NSString};
    use objc2_user_notifications::*;
    use std::{ptr::NonNull, sync::Mutex};
    use tokio::sync::oneshot;

    pub async fn permission(request: bool) -> Result<String, String> {
        let (tx, rx) = oneshot::channel();
        // Objective-C owns a copy of the completion block until it invokes it.
        // Only plain Rust values cross the asynchronous callback boundary.
        {
            let tx = Mutex::new(Some(tx));
            let center = UNUserNotificationCenter::currentNotificationCenter();
            if request {
                let done = RcBlock::new(move |granted: Bool, error: *mut NSError| {
                    let result = if !error.is_null() {
                        Err("Notification authorization unavailable".to_string())
                    } else {
                        Ok(if granted.as_bool() {
                            "granted"
                        } else {
                            "denied"
                        }
                        .to_string())
                    };
                    if let Some(tx) = tx.lock().unwrap().take() {
                        let _ = tx.send(result);
                    }
                });
                center.requestAuthorizationWithOptions_completionHandler(
                    UNAuthorizationOptions::Alert,
                    &done,
                );
            } else {
                let done = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
                    // Apple guarantees settings remains valid for this callback.
                    let status = unsafe { settings.as_ref() }.authorizationStatus();
                    let value = match status {
                        UNAuthorizationStatus::Authorized
                        | UNAuthorizationStatus::Provisional
                        | UNAuthorizationStatus::Ephemeral => "granted",
                        UNAuthorizationStatus::Denied => "denied",
                        _ => "default",
                    };
                    if let Some(tx) = tx.lock().unwrap().take() {
                        let _ = tx.send(Ok(value.to_string()));
                    }
                });
                center.getNotificationSettingsWithCompletionHandler(&done);
            }
        }
        rx.await
            .map_err(|_| "Notification authorization unavailable".to_string())?
    }

    pub async fn show(id: &str, body: &str) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        {
            let tx = Mutex::new(Some(tx));
            let content = UNMutableNotificationContent::new();
            content.setTitle(&NSString::from_str("Ghostly"));
            content.setBody(&NSString::from_str(body));
            content.setSound(None); // Sound preference belongs exclusively to the local audio controller.
            let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
                &NSString::from_str(id),
                &content,
                None,
            );
            let done = RcBlock::new(move |error: *mut NSError| {
                let result = if error.is_null() {
                    Ok(())
                } else {
                    Err("Notification delivery unavailable".to_string())
                };
                if let Some(tx) = tx.lock().unwrap().take() {
                    let _ = tx.send(result);
                }
            });
            UNUserNotificationCenter::currentNotificationCenter()
                .addNotificationRequest_withCompletionHandler(&request, Some(&done));
        }
        rx.await
            .map_err(|_| "Notification delivery unavailable".to_string())?
    }
}

/// Off macOS the notification plugin decides, and nothing is shown from here.
#[cfg(all(test, not(target_os = "macos")))]
mod tests {
    #[tokio::test]
    async fn leaves_permission_and_display_to_the_plugin() {
        assert_eq!(super::native_notification_permission(true).await, Ok(None));
        assert_eq!(
            super::native_private_notification("1".into(), "a message".into()).await,
            Ok(false)
        );
    }
}
