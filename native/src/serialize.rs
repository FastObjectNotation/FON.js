//! Serialization to a file and to library-owned buffers, and the release of those
//! buffers. Each serialize call builds the text once.

use std::ffi::c_void;
use std::path::PathBuf;
use std::ptr;

use fon::serialize::{serialize_dump_to_string, serialize_to_file, serialize_to_string};
use fon::types::FonCollection;

use crate::collection::collection_ref;
use crate::dump::dump_ref;
use crate::error::{finish, invalid, str_arg, to_i64, Failure, FonError};


/// Rejects NULL output parameters before any work is done.
unsafe fn check_out(out: *mut *mut u8, out_len: *mut i64) -> Result<(), Failure> {
    if out.is_null() || out_len.is_null() {
        return Err(invalid("out and out_len must not be null"));
    }
    Ok(())
}


/// Hands a library-owned copy of `bytes` to the caller. Empty output yields NULL and 0.
unsafe fn hand_out(bytes: Vec<u8>, out: *mut *mut u8, out_len: *mut i64) {
    if bytes.is_empty() {
        ptr::write(out, ptr::null_mut());
        ptr::write(out_len, 0);
        return;
    }
    let len: i64 = to_i64(bytes.len());
    let raw: *mut [u8] = Box::into_raw(bytes.into_boxed_slice());
    ptr::write(out, raw as *mut u8);
    ptr::write(out_len, len);
}


/// Releases a buffer returned by a serialize function. NULL or zero length is a no-op.
#[no_mangle]
pub extern "C" fn fon_buffer_free(buffer: *mut u8, len: i64) {
    if buffer.is_null() || len <= 0 {
        return;
    }
    unsafe {
        drop(Box::from_raw(ptr::slice_from_raw_parts_mut(buffer, len as usize)));
    }
}


#[no_mangle]
pub extern "C" fn fon_serialize_dump(
    dump: *mut c_void,
    max_threads: i32,
    out: *mut *mut u8,
    out_len: *mut i64,
    error: *mut FonError,
) -> i32 {
    let result: Result<(), Failure> = unsafe { serialize_dump_into(dump, max_threads, out, out_len) };
    unsafe { finish(error, result) }
}


unsafe fn serialize_dump_into(
    dump: *mut c_void,
    max_threads: i32,
    out: *mut *mut u8,
    out_len: *mut i64,
) -> Result<(), Failure> {
    check_out(out, out_len)?;
    let d = dump_ref(dump)?;
    let text: String = serialize_dump_to_string(d, max_threads);
    hand_out(text.into_bytes(), out, out_len);
    Ok(())
}


#[no_mangle]
pub extern "C" fn fon_serialize_collection(
    collection: *mut c_void,
    out: *mut *mut u8,
    out_len: *mut i64,
    error: *mut FonError,
) -> i32 {
    let result: Result<(), Failure> = unsafe { serialize_collection_into(collection, out, out_len) };
    unsafe { finish(error, result) }
}


unsafe fn serialize_collection_into(
    collection: *mut c_void,
    out: *mut *mut u8,
    out_len: *mut i64,
) -> Result<(), Failure> {
    check_out(out, out_len)?;
    let c: &FonCollection = collection_ref(collection)?;
    let text: String = serialize_to_string(c);
    hand_out(text.into_bytes(), out, out_len);
    Ok(())
}


#[no_mangle]
pub extern "C" fn fon_serialize_to_file(
    dump: *mut c_void,
    path: *const u8,
    path_len: i64,
    max_threads: i32,
    error: *mut FonError,
) -> i32 {
    let result: Result<(), Failure> =
        unsafe { serialize_to_file_into(dump, path, path_len, max_threads) };
    unsafe { finish(error, result) }
}


unsafe fn serialize_to_file_into(
    dump: *mut c_void,
    path: *const u8,
    path_len: i64,
    max_threads: i32,
) -> Result<(), Failure> {
    let d = dump_ref(dump)?;
    let target: PathBuf = PathBuf::from(str_arg(path, path_len)?);
    serialize_to_file(d, &target, max_threads).map_err(Failure::from)
}
