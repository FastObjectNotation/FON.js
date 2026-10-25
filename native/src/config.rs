//! Version reporting and the global deserialization settings.

use std::ffi::c_char;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};

use fon::DeserializeOptions;


pub static DESERIALIZE_RAW_UNPACK: AtomicBool = AtomicBool::new(false);
pub static MAX_DEPTH: AtomicI32 = AtomicI32::new(64);


pub(crate) fn deserialize_options() -> DeserializeOptions {
    DeserializeOptions {
        max_depth: MAX_DEPTH.load(Ordering::Relaxed),
        unpack_raw: DESERIALIZE_RAW_UNPACK.load(Ordering::Relaxed),
    }
}


#[no_mangle]
pub extern "C" fn fon_version() -> *const c_char {
    concat!(env!("CARGO_PKG_VERSION"), "\0").as_ptr().cast()
}


#[no_mangle]
pub extern "C" fn fon_set_raw_unpack(enable: i32) {
    DESERIALIZE_RAW_UNPACK.store(enable != 0, Ordering::Relaxed);
}


#[no_mangle]
pub extern "C" fn fon_set_max_depth(depth: i32) {
    MAX_DEPTH.store(depth.max(1), Ordering::Relaxed);
}
