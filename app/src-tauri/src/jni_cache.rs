#[cfg(target_os = "android")]
use jni::objects::{GlobalRef, JClass, JObject, JValue};
#[cfg(target_os = "android")]
use jni::{JNIEnv, JavaVM};
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

#[cfg(target_os = "android")]
pub fn is_initialized() -> bool {
    INITIALIZED.load(Ordering::SeqCst)
}

#[cfg(not(target_os = "android"))]
pub fn is_initialized() -> bool {
    true
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
/// - This is the standard idiom in jni 0.21 where no safe `From<&JObject>` impl exists.
#[cfg(target_os = "android")]
pub fn get_main_activity_jclass() -> Option<JClass<'static>> {
    MAIN_ACTIVITY_CLASS.get().map(|global_ref| {
        // SAFETY: JClass is repr(transparent) over JObject; both wrap the same raw pointer.
        // The GlobalRef ensures the underlying class reference is never GC'd.
        unsafe { std::mem::transmute_copy(global_ref.as_obj()) }
    })
}

/// Executes safe JNI initialization using the JNIEnv and an Activity/Context object.
/// Sets up `ndk-context`, caches ClassLoader, and caches MainActivity class reference.
#[cfg(target_os = "android")]
pub fn init_from_env_and_activity(env: &mut JNIEnv, activity: &JObject) {
    if INITIALIZED.load(Ordering::SeqCst) {
        return;
    }

    if let Ok(vm) = env.get_java_vm() {
        let vm_ptr = vm.get_java_vm_pointer().cast();
        let act_ptr = activity.as_raw().cast();
        unsafe {
            let _ = ndk_context::initialize_android_context(vm_ptr, act_ptr);
        }
        log::info!("JNI: ndk-context initialized successfully");
    } else {
        log::error!("JNI: Failed to get JavaVM from JNIEnv");
        return;
    }

    if let Ok(act_global) = env.new_global_ref(activity) {
        let _ = ANDROID_APP_CONTEXT.set(act_global);
    }

    // 1. Cache MainActivity class reference directly from object
    if let Ok(act_class) = env.get_object_class(activity) {
        if let Ok(class_global) = env.new_global_ref(&act_class) {
            let _ = MAIN_ACTIVITY_CLASS.set(class_global);
            log::info!("JNI: MainActivity class reference cached globally via get_object_class");
        }
    }

    // 2. Cache ClassLoader reference
    if let Ok(class_loader_val) = env.call_method(
        activity,
        "getClassLoader",
        "()Ljava/lang/ClassLoader;",
        &[],
    ) {
        if let Ok(class_loader_obj) = class_loader_val.l() {
            if let Ok(class_loader_global) = env.new_global_ref(&class_loader_obj) {
                let _ = CLASS_LOADER.set(class_loader_global);
                log::info!("JNI: ClassLoader cached globally");
            }

            // Fallback: If MainActivity class wasn't cached yet, try ClassLoader.loadClass
            if MAIN_ACTIVITY_CLASS.get().is_none() {
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
                                log::info!("JNI: MainActivity class reference cached via ClassLoader.loadClass");
                            }
                        }
                    }
                }
            }
        }
    }

    INITIALIZED.store(true, Ordering::SeqCst);
}

/// Native method called directly by MainActivity during onCreate:
/// `private external fun nativeInit(activity: Any)`
#[cfg(target_os = "android")]
#[no_mangle]
pub unsafe extern "C" fn Java_com_bigblast66_telegramdrive_MainActivity_nativeInit(
    mut env: JNIEnv,
    _this: JObject,
    activity: JObject,
) {
    log::info!("JNI: Java_com_bigblast66_telegramdrive_MainActivity_nativeInit invoked");
    init_from_env_and_activity(&mut env, &activity);
}

/// Fallback export if called via companion object:
#[cfg(target_os = "android")]
#[no_mangle]
pub unsafe extern "C" fn Java_com_bigblast66_telegramdrive_MainActivity_00024Companion_nativeInit(
    mut env: JNIEnv,
    _this: JObject,
    activity: JObject,
) {
    log::info!("JNI: Java_com_bigblast66_telegramdrive_MainActivity_Companion_nativeInit invoked");
    init_from_env_and_activity(&mut env, &activity);
}
