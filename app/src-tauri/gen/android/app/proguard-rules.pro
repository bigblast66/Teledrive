# Preserve all application classes, methods, and companion objects for JNI reflection
-keep class com.bigblast66.telegramdrive.** { *; }
-keepclassmembers class com.bigblast66.telegramdrive.** { *; }
-dontwarn com.bigblast66.telegramdrive.**

# Keep Tauri mobile runtime and plugins
-keep class app.tauri.** { *; }
-keepclassmembers class app.tauri.** { *; }
