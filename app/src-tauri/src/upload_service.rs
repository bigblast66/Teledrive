#[cfg(target_os = "android")]
pub fn start_foreground_service() {
    log::info!("JNI: start_foreground_service called");
    let ctx_obj = match crate::jni_cache::get_android_context() {
        Some(ctx) => ctx,
        None => {
            log::warn!("JNI: Android context not initialized yet in start_foreground_service");
            return;
        }
    };
    if let Ok(vm) = unsafe { jni::JavaVM::from_raw(ctx_obj.vm().cast()) } {
        if let Ok(mut env) = vm.attach_current_thread() {
            let ctx = unsafe { jni::objects::JObject::from_raw(ctx_obj.context().cast()) };
            
            // Get class loader from Context
            match env.call_method(
                &ctx,
                "getClassLoader",
                "()Ljava/lang/ClassLoader;",
                &[],
            ) {
                Ok(class_loader_val) => {
                    if let Ok(class_loader) = class_loader_val.l() {
                        let class_name = env.new_string("com.bigblast66.telegramdrive.UploadForegroundService");
                        if let Ok(class_name_obj) = class_name {
                            let class_obj_val = env.call_method(
                                &class_loader,
                                "loadClass",
                                "(Ljava/lang/String;)Ljava/lang/Class;",
                                &[jni::objects::JValue::from(&class_name_obj)],
                            );
                            match class_obj_val {
                                Ok(class_obj_res) => {
                                    if let Ok(class_obj) = class_obj_res.l() {
                                        let j_class: jni::objects::JClass = class_obj.into();
                                        let call_res = env.call_static_method(
                                            &j_class,
                                            "startService",
                                            "(Landroid/content/Context;)V",
                                            &[jni::objects::JValue::from(&ctx)],
                                        );
                                        if let Err(e) = call_res {
                                            log::error!("JNI: startService call failed: {}", e);
                                            if env.exception_check().unwrap_or(false) {
                                                let _ = env.exception_describe();
                                                let _ = env.exception_clear();
                                            }
                                        } else {
                                            log::info!("JNI: successfully called UploadForegroundService.startService");
                                        }
                                    }
                                }
                                Err(e) => {
                                    log::error!("JNI: loadClass UploadForegroundService failed: {}", e);
                                    if env.exception_check().unwrap_or(false) {
                                        let _ = env.exception_describe();
                                        let _ = env.exception_clear();
                                    }
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    log::error!("JNI: getClassLoader failed: {}", e);
                    if env.exception_check().unwrap_or(false) {
                        let _ = env.exception_describe();
                        let _ = env.exception_clear();
                    }
                }
            }
        }
    }
}

#[cfg(target_os = "android")]
pub fn stop_foreground_service() {
    log::info!("JNI: stop_foreground_service called");
    let ctx_obj = match crate::jni_cache::get_android_context() {
        Some(ctx) => ctx,
        None => {
            log::warn!("JNI: Android context not initialized yet in stop_foreground_service");
            return;
        }
    };
    if let Ok(vm) = unsafe { jni::JavaVM::from_raw(ctx_obj.vm().cast()) } {
        if let Ok(mut env) = vm.attach_current_thread() {
            let ctx = unsafe { jni::objects::JObject::from_raw(ctx_obj.context().cast()) };
            
            // Get class loader from Context
            match env.call_method(
                &ctx,
                "getClassLoader",
                "()Ljava/lang/ClassLoader;",
                &[],
            ) {
                Ok(class_loader_val) => {
                    if let Ok(class_loader) = class_loader_val.l() {
                        let class_name = env.new_string("com.bigblast66.telegramdrive.UploadForegroundService");
                        if let Ok(class_name_obj) = class_name {
                            let class_obj_val = env.call_method(
                                &class_loader,
                                "loadClass",
                                "(Ljava/lang/String;)Ljava/lang/Class;",
                                &[jni::objects::JValue::from(&class_name_obj)],
                            );
                            match class_obj_val {
                                Ok(class_obj_res) => {
                                    if let Ok(class_obj) = class_obj_res.l() {
                                        let j_class: jni::objects::JClass = class_obj.into();
                                        let call_res = env.call_static_method(
                                            &j_class,
                                            "stopService",
                                            "(Landroid/content/Context;)V",
                                            &[jni::objects::JValue::from(&ctx)],
                                        );
                                        if let Err(e) = call_res {
                                            log::error!("JNI: stopService call failed: {}", e);
                                            if env.exception_check().unwrap_or(false) {
                                                let _ = env.exception_describe();
                                                let _ = env.exception_clear();
                                            }
                                        } else {
                                            log::info!("JNI: successfully called UploadForegroundService.stopService");
                                        }
                                    }
                                }
                                Err(e) => {
                                    log::error!("JNI: loadClass UploadForegroundService failed: {}", e);
                                    if env.exception_check().unwrap_or(false) {
                                        let _ = env.exception_describe();
                                        let _ = env.exception_clear();
                                    }
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    log::error!("JNI: getClassLoader failed: {}", e);
                    if env.exception_check().unwrap_or(false) {
                        let _ = env.exception_describe();
                        let _ = env.exception_clear();
                    }
                }
            }
        }
    }
}

#[cfg(not(target_os = "android"))]
pub fn start_foreground_service() {
    // Desktop doesn't need this.
}

#[cfg(not(target_os = "android"))]
pub fn stop_foreground_service() {
    // Desktop doesn't need this.
}

#[tauri::command]
pub fn cmd_start_foreground_service(#[allow(unused)] app_handle: tauri::AppHandle) {
    #[cfg(target_os = "android")]
    {
        crate::jni_cache::ensure_initialized_from_app(&app_handle);
        start_foreground_service();
    }
}

#[tauri::command]
pub fn cmd_stop_foreground_service(#[allow(unused)] app_handle: tauri::AppHandle) {
    #[cfg(target_os = "android")]
    {
        crate::jni_cache::ensure_initialized_from_app(&app_handle);
        stop_foreground_service();
    }
}
