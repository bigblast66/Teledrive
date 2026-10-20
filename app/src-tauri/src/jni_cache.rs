#[cfg(target_os = "android")]
use jni::objects::{GlobalRef, JClass, JObject, JValue};
#[cfg(target_os = "android")]
use jni::JNIEnv;
#[cfg(target_os = "android")]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_os = "android")]
use std::sync::OnceLock;

#[cfg(target_os = "android")]
static INITIALIZED: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "android")]
static CLASS_LOADER: OnceLock<GlobalRef> = OnceLock::new();
#[cfg(target_os = "android")]
static MAIN_ACTIVITY_CLASS: OnceLock<GlobalRef> = OnceLock::new();
#[cfg(target_os = "android")]
static ANDROID_APP_CONTEXT: OnceLock<GlobalRef> = OnceLock::new();

pub fn is_initialized() -> bool {
    #[cfg(target_os = "android")]
    {
        INITIALIZED.load(Ordering::SeqCst)
    }
    #[cfg(not(target_os = "android"))]
    {
        true
    }
}

#[cfg(target_os = "android")]
pub fn get_android_context() -> Option<ndk_context::AndroidContext> {
    if !INITIALIZED.load(Ordering::SeqCst) {
        return None;
    }
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ndk_context::android_context()
    })).ok()
}

#[cfg(target_os = "android")]
pub fn set_class_loader(class_loader: GlobalRef) -> Result<(), GlobalRef> {
    CLASS_LOADER.set(class_loader)
}

#[cfg(target_os = "android")]
pub fn get_class_loader() -> Option<&'static GlobalRef> {
    CLASS_LOADER.get()
}

#[cfg(target_os = "android")]
pub fn set_main_activity_class(main_activity_class: GlobalRef) -> Result<(), GlobalRef> {
    MAIN_ACTIVITY_CLASS.set(main_activity_class)
}

#[cfg(target_os = "android")]
pub fn get_main_activity_class() -> Option<&'static GlobalRef> {
    MAIN_ACTIVITY_CLASS.get()
}

/// Returns a JClass for the cached MainActivity class reference.
///
/// # Safety
///
/// Uses `transmute_copy` to convert `&JObject` to `JClass`. This is safe because:
/// - `JClass` is a transparent wrapper around `JObject` (both hold a single raw JNI pointer).
/// - The `GlobalRef` stored in the static cache ensures the JNI global reference
///   is never garbage-collected for the lifetime of the process.
#[cfg(target_os = "android")]
pub fn get_main_activity_jclass() -> Option<JClass<'static>> {
    MAIN_ACTIVITY_CLASS.get().map(|global_ref| {
        unsafe { std::mem::transmute_copy(global_ref.as_obj()) }
    })
}

/// Initializes ndk-context using a permanent GlobalRef to the Android Context,
/// caches ClassLoader and MainActivity class reference for future JNI invocations.
#[cfg(target_os = "android")]
pub fn init_from_env_and_activity(env: &mut JNIEnv, context: &JObject) {
    if INITIALIZED.load(Ordering::SeqCst) {
        return;
    }

    // 1. Get JavaVM and register ndk-context using a permanent GlobalRef
    if let Ok(vm) = env.get_java_vm() {
        if let Ok(global_ctx) = env.new_global_ref(context) {
            let vm_ptr = vm.get_java_vm_pointer().cast();
            let act_ptr = global_ctx.as_obj().as_raw().cast();
            unsafe {
                let _ = ndk_context::initialize_android_context(vm_ptr, act_ptr);
            }
            let _ = ANDROID_APP_CONTEXT.set(global_ctx);
            log::info!("JNI: ndk-context initialized successfully with global context.");
        } else {
            log::error!("JNI: Failed to create global ref for context.");
            return;
        }
    } else {
        log::error!("JNI: Failed to get JavaVM from JNIEnv.");
        return;
    }

    // 2. Cache ClassLoader reference
    if let Ok(class_loader_val) = env.call_method(
        context,
        "getClassLoader",
        "()Ljava/lang/ClassLoader;",
        &[],
    ) {
        if let Ok(class_loader_obj) = class_loader_val.l() {
            if let Ok(class_loader_global) = env.new_global_ref(&class_loader_obj) {
                // 3. Load and cache MainActivity class reference via ClassLoader
                if let Ok(class_name_jstr) = env.new_string("com.bigblast66.telegramdrive.MainActivity") {
                    if let Ok(main_class_obj_val) = env.call_method(
                        &class_loader_obj,
                        "loadClass",
                        "(Ljava/lang/String;)Ljava/lang/Class;",
                        &[JValue::from(&class_name_jstr)],
                    ) {
                        if let Ok(main_class_obj) = main_class_obj_val.l() {
                            if let Ok(main_class_global) = env.new_global_ref(main_class_obj) {
                                let _ = MAIN_ACTIVITY_CLASS.set(main_class_global);
                                log::info!("JNI: MainActivity class reference cached globally.");
                            }
                        }
                    }
                }
                let _ = CLASS_LOADER.set(class_loader_global);
            }
        }
    }

    let _ = env.exception_clear();
    INITIALIZED.store(true, Ordering::SeqCst);
}

/// Ensures JNI is initialized from the active webview handle if not already done.
#[cfg(target_os = "android")]
pub fn ensure_initialized_from_app(app: &tauri::AppHandle) {
    if is_initialized() {
        return;
    }
    use tauri::Manager;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.with_webview(|webview| {
            webview.jni_handle().exec(|env, context, _webview| {
                init_from_env_and_activity(env, &context);
            });
        });
    }
}
