#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// The app itself is in lib.rs, which the mobile builds load as a library.
fn main() {
    ghostly_lib::run()
}
