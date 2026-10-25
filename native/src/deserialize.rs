//! Deserialization from a file and from a caller-supplied buffer: a dump (many
//! lines) or a single collection (one line). Results are owned by the caller.

use std::ffi::c_void;
use std::fs;
use std::io::ErrorKind;
use std::path::PathBuf;

use fon::deserialize::{deserialize_dump_from_bytes, deserialize_from_file, deserialize_line};
use fon::types::{FonCollection, FonDump};

use crate::config::deserialize_options;
use crate::error::{
    handle_or_report, slice_arg, str_arg, Failure, FonError, FON_ERROR_FILE_NOT_FOUND,
};


#[no_mangle]
pub extern "C" fn fon_deserialize_dump(
    data: *const u8,
    len: i64,
    max_threads: i32,
    error: *mut FonError,
) -> *mut c_void {
    let result: Result<*mut c_void, Failure> =
        unsafe { deserialize_dump_into(data, len, max_threads) };
    unsafe { handle_or_report(error, result) }
}


unsafe fn deserialize_dump_into(
    data: *const u8,
    len: i64,
    max_threads: i32,
) -> Result<*mut c_void, Failure> {
    let bytes: &[u8] = slice_arg(data, len)?;
    let dump: FonDump = deserialize_dump_from_bytes(bytes, max_threads, &deserialize_options())?;
    Ok(Box::into_raw(Box::new(dump)).cast())
}


#[no_mangle]
pub extern "C" fn fon_deserialize_collection(
    data: *const u8,
    len: i64,
    error: *mut FonError,
) -> *mut c_void {
    let result: Result<*mut c_void, Failure> = unsafe { deserialize_collection_into(data, len) };
    unsafe { handle_or_report(error, result) }
}


unsafe fn deserialize_collection_into(data: *const u8, len: i64) -> Result<*mut c_void, Failure> {
    let bytes: &[u8] = slice_arg(data, len)?;
    let collection: FonCollection = deserialize_line(bytes, &deserialize_options())?;
    Ok(Box::into_raw(Box::new(collection)).cast())
}


/// A missing file yields `FON_ERROR_FILE_NOT_FOUND`.
#[no_mangle]
pub extern "C" fn fon_deserialize_from_file(
    path: *const u8,
    path_len: i64,
    max_threads: i32,
    error: *mut FonError,
) -> *mut c_void {
    let result: Result<*mut c_void, Failure> =
        unsafe { deserialize_from_file_into(path, path_len, max_threads) };
    unsafe { handle_or_report(error, result) }
}


unsafe fn deserialize_from_file_into(
    path: *const u8,
    path_len: i64,
    max_threads: i32,
) -> Result<*mut c_void, Failure> {
    let target: PathBuf = PathBuf::from(str_arg(path, path_len)?);
    if let Err(io_error) = fs::metadata(&target) {
        if io_error.kind() == ErrorKind::NotFound {
            return Err(Failure::new(
                FON_ERROR_FILE_NOT_FOUND,
                format!("file '{}' not found", target.display()),
            ));
        }
    }
    let dump: FonDump = deserialize_from_file(&target, max_threads, &deserialize_options())?;
    Ok(Box::into_raw(Box::new(dump)).cast())
}
