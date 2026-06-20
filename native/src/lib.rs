//! FON native library — C ABI shim over the `fon` crate.
//!
//! Exposes a C ABI matching the original `fon_export.h` so the .NET P/Invoke
//! bindings (`NativeBindings.cs`) work without any change.

use std::ffi::{c_char, c_void, CStr};
use std::path::PathBuf;
use std::ptr;
use std::slice;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};

use fon::deserialize::{deserialize_dump_from_bytes, deserialize_from_file, deserialize_line};
use fon::serialize::{serialize_dump_to_string, serialize_to_file, serialize_to_string};
use fon::types::{FonCollection, FonDump, FonValue};
use fon::{DeserializeOptions, FonError as FonLibError};


// Result codes mirror fon_export.h.
pub const FON_OK: i32 = 0;
pub const FON_ERROR_FILE_NOT_FOUND: i32 = 1;
pub const FON_ERROR_PARSE_FAILED: i32 = 2;
pub const FON_ERROR_WRITE_FAILED: i32 = 3;
pub const FON_ERROR_INVALID_ARGUMENT: i32 = 4;


static DESERIALIZE_RAW_UNPACK: AtomicBool = AtomicBool::new(false);
static MAX_DEPTH: AtomicI32 = AtomicI32::new(64);


#[repr(C)]
pub struct FonError {
    pub code: i32,
    pub message: [u8; 256],
}


fn set_error(error: *mut FonError, code: i32, message: &str) {
    if error.is_null() {
        return;
    }
    unsafe {
        (*error).code = code;
        let buf = &mut (*error).message;
        for b in buf.iter_mut() {
            *b = 0;
        }
        let bytes = message.as_bytes();
        let n = bytes.len().min(buf.len() - 1);
        buf[..n].copy_from_slice(&bytes[..n]);
        buf[n] = 0;
    }
}


fn err_code(e: &FonLibError) -> i32 {
    match e {
        FonLibError::Parse(_) => FON_ERROR_PARSE_FAILED,
        FonLibError::Write(_) => FON_ERROR_WRITE_FAILED,
        FonLibError::InvalidArgument(_) => FON_ERROR_INVALID_ARGUMENT,
    }
}


unsafe fn cstr_to_str<'a>(p: *const c_char) -> Result<&'a str, FonLibError> {
    if p.is_null() {
        return Err(FonLibError::InvalidArgument("null pointer".into()));
    }
    CStr::from_ptr(p)
        .to_str()
        .map_err(|_| FonLibError::InvalidArgument("invalid UTF-8".into()))
}


fn version_cstr() -> *const c_char {
    concat!(env!("CARGO_PKG_VERSION"), "\0").as_ptr() as *const c_char
}


// ==================== VERSION ====================

#[no_mangle]
pub extern "C" fn fon_version() -> *const c_char {
    version_cstr()
}


// ==================== CONFIGURATION ====================

#[no_mangle]
pub extern "C" fn fon_set_raw_unpack(enable: i32) {
    DESERIALIZE_RAW_UNPACK.store(enable != 0, Ordering::Relaxed);
}


#[no_mangle]
pub extern "C" fn fon_set_max_depth(depth: i32) {
    let d = if depth < 1 { 1 } else { depth };
    MAX_DEPTH.store(d, Ordering::Relaxed);
}


// ==================== MEMORY MANAGEMENT ====================

#[no_mangle]
pub extern "C" fn fon_dump_create() -> *mut c_void {
    Box::into_raw(Box::new(FonDump::new())) as *mut c_void
}


#[no_mangle]
pub extern "C" fn fon_dump_free(dump: *mut c_void) {
    if dump.is_null() {
        return;
    }
    unsafe {
        drop(Box::from_raw(dump as *mut FonDump));
    }
}


#[no_mangle]
pub extern "C" fn fon_dump_size(dump: *mut c_void) -> i64 {
    if dump.is_null() {
        return 0;
    }
    unsafe { (*(dump as *const FonDump)).len() as i64 }
}


#[no_mangle]
pub extern "C" fn fon_dump_get(dump: *mut c_void, index: u64) -> *mut c_void {
    if dump.is_null() {
        return ptr::null_mut();
    }
    unsafe {
        let d = &mut *(dump as *mut FonDump);
        match d.get_mut(index) {
            Some(c) => c as *mut FonCollection as *mut c_void,
            None => ptr::null_mut(),
        }
    }
}


#[no_mangle]
pub extern "C" fn fon_collection_create() -> *mut c_void {
    Box::into_raw(Box::new(FonCollection::new())) as *mut c_void
}


#[no_mangle]
pub extern "C" fn fon_collection_free(collection: *mut c_void) {
    if collection.is_null() {
        return;
    }
    unsafe {
        drop(Box::from_raw(collection as *mut FonCollection));
    }
}


#[no_mangle]
pub extern "C" fn fon_collection_size(collection: *mut c_void) -> i64 {
    if collection.is_null() {
        return 0;
    }
    unsafe { (*(collection as *const FonCollection)).len() as i64 }
}


// ==================== SERIALIZATION ====================

#[no_mangle]
pub extern "C" fn fon_serialize_to_file(
    dump: *mut c_void,
    path: *const c_char,
    max_threads: i32,
    error: *mut FonError,
) -> i32 {
    if dump.is_null() || path.is_null() {
        set_error(
            error,
            FON_ERROR_INVALID_ARGUMENT,
            "Invalid argument: dump or path is null",
        );
        return FON_ERROR_INVALID_ARGUMENT;
    }
    let path_str = match unsafe { cstr_to_str(path) } {
        Ok(s) => s,
        Err(e) => {
            set_error(error, FON_ERROR_INVALID_ARGUMENT, &e.to_string());
            return FON_ERROR_INVALID_ARGUMENT;
        }
    };

    let d = unsafe { &*(dump as *const FonDump) };
    match serialize_to_file(d, &PathBuf::from(path_str), max_threads) {
        Ok(()) => FON_OK,
        Err(e) => {
            let code = err_code(&e);
            set_error(error, code, &e.to_string());
            code
        }
    }
}


// ==================== DESERIALIZATION ====================

#[no_mangle]
pub extern "C" fn fon_deserialize_from_file(
    path: *const c_char,
    max_threads: i32,
    error: *mut FonError,
) -> *mut c_void {
    if path.is_null() {
        set_error(
            error,
            FON_ERROR_INVALID_ARGUMENT,
            "Invalid argument: path is null",
        );
        return ptr::null_mut();
    }
    let path_str = match unsafe { cstr_to_str(path) } {
        Ok(s) => s,
        Err(e) => {
            set_error(error, FON_ERROR_INVALID_ARGUMENT, &e.to_string());
            return ptr::null_mut();
        }
    };

    let opts = DeserializeOptions {
        max_depth: MAX_DEPTH.load(Ordering::Relaxed),
        unpack_raw: DESERIALIZE_RAW_UNPACK.load(Ordering::Relaxed),
    };
    match deserialize_from_file(&PathBuf::from(path_str), max_threads, &opts) {
        Ok(dump) => Box::into_raw(Box::new(dump)) as *mut c_void,
        Err(e) => {
            let code = err_code(&e);
            set_error(error, code, &e.to_string());
            ptr::null_mut()
        }
    }
}


// ==================== STRING / BUFFER SERIALIZATION ====================

// Two-call pattern (matches fon_collection_get_int_array):
//   1. Pass buffer=null, buffer_size=0 to read required size into *required_size.
//   2. Allocate buffer of required_size bytes, call again to receive UTF-8 bytes.
// Output is NOT null-terminated; *required_size is the exact byte count.

unsafe fn write_buffer(
    bytes: &[u8],
    buffer: *mut u8,
    buffer_size: i64,
    required_size: *mut i64,
) -> i32 {
    if !required_size.is_null() {
        *required_size = bytes.len() as i64;
    }
    if !buffer.is_null() && buffer_size > 0 {
        let copy_count = (buffer_size as usize).min(bytes.len());
        let dst = slice::from_raw_parts_mut(buffer, copy_count);
        dst.copy_from_slice(&bytes[..copy_count]);
    }
    FON_OK
}


#[no_mangle]
pub extern "C" fn fon_serialize_dump_to_buffer(
    dump: *mut c_void,
    buffer: *mut u8,
    buffer_size: i64,
    required_size: *mut i64,
    max_threads: i32,
    error: *mut FonError,
) -> i32 {
    if dump.is_null() || required_size.is_null() {
        set_error(error, FON_ERROR_INVALID_ARGUMENT, "Invalid argument");
        return FON_ERROR_INVALID_ARGUMENT;
    }
    let d = unsafe { &*(dump as *const FonDump) };
    let s = serialize_dump_to_string(d, max_threads);
    unsafe { write_buffer(s.as_bytes(), buffer, buffer_size, required_size) }
}


#[no_mangle]
pub extern "C" fn fon_serialize_collection_to_buffer(
    collection: *mut c_void,
    buffer: *mut u8,
    buffer_size: i64,
    required_size: *mut i64,
    error: *mut FonError,
) -> i32 {
    if collection.is_null() || required_size.is_null() {
        set_error(error, FON_ERROR_INVALID_ARGUMENT, "Invalid argument");
        return FON_ERROR_INVALID_ARGUMENT;
    }
    let c = unsafe { &*(collection as *const FonCollection) };
    let s = serialize_to_string(c);
    unsafe { write_buffer(s.as_bytes(), buffer, buffer_size, required_size) }
}


// ==================== STRING / BUFFER DESERIALIZATION ====================

#[no_mangle]
pub extern "C" fn fon_deserialize_dump_from_buffer(
    data: *const u8,
    size: i64,
    max_threads: i32,
    error: *mut FonError,
) -> *mut c_void {
    if (data.is_null() && size > 0) || size < 0 {
        set_error(error, FON_ERROR_INVALID_ARGUMENT, "Invalid argument");
        return ptr::null_mut();
    }
    let bytes = if size == 0 {
        &[][..]
    } else {
        unsafe { slice::from_raw_parts(data, size as usize) }
    };
    let opts = DeserializeOptions {
        max_depth: MAX_DEPTH.load(Ordering::Relaxed),
        unpack_raw: DESERIALIZE_RAW_UNPACK.load(Ordering::Relaxed),
    };
    match deserialize_dump_from_bytes(bytes, max_threads, &opts) {
        Ok(dump) => Box::into_raw(Box::new(dump)) as *mut c_void,
        Err(e) => {
            let code = err_code(&e);
            set_error(error, code, &e.to_string());
            ptr::null_mut()
        }
    }
}


#[no_mangle]
pub extern "C" fn fon_deserialize_collection_from_buffer(
    data: *const u8,
    size: i64,
    error: *mut FonError,
) -> *mut c_void {
    if (data.is_null() && size > 0) || size < 0 {
        set_error(error, FON_ERROR_INVALID_ARGUMENT, "Invalid argument");
        return ptr::null_mut();
    }
    let bytes = if size == 0 {
        &[][..]
    } else {
        unsafe { slice::from_raw_parts(data, size as usize) }
    };
    let opts = DeserializeOptions {
        max_depth: MAX_DEPTH.load(Ordering::Relaxed),
        unpack_raw: DESERIALIZE_RAW_UNPACK.load(Ordering::Relaxed),
    };
    match deserialize_line(bytes, &opts) {
        Ok(c) => Box::into_raw(Box::new(c)) as *mut c_void,
        Err(e) => {
            let code = err_code(&e);
            set_error(error, code, &e.to_string());
            ptr::null_mut()
        }
    }
}


// ==================== COLLECTION ADD OPERATIONS ====================

#[no_mangle]
pub extern "C" fn fon_dump_add(
    dump: *mut c_void,
    id: u64,
    collection: *mut c_void,
    error: *mut FonError,
) -> i32 {
    if dump.is_null() || collection.is_null() {
        set_error(error, FON_ERROR_INVALID_ARGUMENT, "Invalid argument");
        return FON_ERROR_INVALID_ARGUMENT;
    }
    unsafe {
        let d = &mut *(dump as *mut FonDump);
        // Take ownership of the collection — caller must not free it again.
        let c = Box::from_raw(collection as *mut FonCollection);
        d.add(id, *c);
    }
    FON_OK
}


unsafe fn add_to_collection(
    collection: *mut c_void,
    key: *const c_char,
    error: *mut FonError,
    f: impl FnOnce(&mut FonCollection, String),
) -> i32 {
    if collection.is_null() || key.is_null() {
        set_error(error, FON_ERROR_INVALID_ARGUMENT, "Invalid argument");
        return FON_ERROR_INVALID_ARGUMENT;
    }
    let k = match cstr_to_str(key) {
        Ok(s) => s.to_owned(),
        Err(e) => {
            set_error(error, FON_ERROR_INVALID_ARGUMENT, &e.to_string());
            return FON_ERROR_INVALID_ARGUMENT;
        }
    };
    let c = &mut *(collection as *mut FonCollection);
    f(c, k);
    FON_OK
}


#[no_mangle]
pub extern "C" fn fon_collection_add_int(
    collection: *mut c_void,
    key: *const c_char,
    value: i32,
    error: *mut FonError,
) -> i32 {
    unsafe { add_to_collection(collection, key, error, |c, k| c.add(k, FonValue::Int(value))) }
}


#[no_mangle]
pub extern "C" fn fon_collection_add_long(
    collection: *mut c_void,
    key: *const c_char,
    value: i64,
    error: *mut FonError,
) -> i32 {
    unsafe { add_to_collection(collection, key, error, |c, k| c.add(k, FonValue::Long(value))) }
}


#[no_mangle]
pub extern "C" fn fon_collection_add_float(
    collection: *mut c_void,
    key: *const c_char,
    value: f32,
    error: *mut FonError,
) -> i32 {
    unsafe { add_to_collection(collection, key, error, |c, k| c.add(k, FonValue::Float(value))) }
}


#[no_mangle]
pub extern "C" fn fon_collection_add_double(
    collection: *mut c_void,
    key: *const c_char,
    value: f64,
    error: *mut FonError,
) -> i32 {
    unsafe { add_to_collection(collection, key, error, |c, k| c.add(k, FonValue::Double(value))) }
}


#[no_mangle]
pub extern "C" fn fon_collection_add_bool(
    collection: *mut c_void,
    key: *const c_char,
    value: i32,
    error: *mut FonError,
) -> i32 {
    unsafe {
        add_to_collection(collection, key, error, |c, k| {
            c.add(k, FonValue::Bool(value != 0))
        })
    }
}


#[no_mangle]
pub extern "C" fn fon_collection_add_string(
    collection: *mut c_void,
    key: *const c_char,
    value: *const c_char,
    error: *mut FonError,
) -> i32 {
    if collection.is_null() || key.is_null() || value.is_null() {
        set_error(error, FON_ERROR_INVALID_ARGUMENT, "Invalid argument");
        return FON_ERROR_INVALID_ARGUMENT;
    }
    let k = match unsafe { cstr_to_str(key) } {
        Ok(s) => s.to_owned(),
        Err(e) => {
            set_error(error, FON_ERROR_INVALID_ARGUMENT, &e.to_string());
            return FON_ERROR_INVALID_ARGUMENT;
        }
    };
    let v = match unsafe { cstr_to_str(value) } {
        Ok(s) => s.to_owned(),
        Err(e) => {
            set_error(error, FON_ERROR_INVALID_ARGUMENT, &e.to_string());
            return FON_ERROR_INVALID_ARGUMENT;
        }
    };
    unsafe {
        let c = &mut *(collection as *mut FonCollection);
        c.add(k, FonValue::String(v));
    }
    FON_OK
}


#[no_mangle]
pub extern "C" fn fon_collection_add_int_array(
    collection: *mut c_void,
    key: *const c_char,
    values: *const i32,
    count: i64,
    error: *mut FonError,
) -> i32 {
    if collection.is_null() || key.is_null() || values.is_null() || count < 0 {
        set_error(error, FON_ERROR_INVALID_ARGUMENT, "Invalid argument");
        return FON_ERROR_INVALID_ARGUMENT;
    }
    let k = match unsafe { cstr_to_str(key) } {
        Ok(s) => s.to_owned(),
        Err(e) => {
            set_error(error, FON_ERROR_INVALID_ARGUMENT, &e.to_string());
            return FON_ERROR_INVALID_ARGUMENT;
        }
    };
    let vec = unsafe { slice::from_raw_parts(values, count as usize).to_vec() };
    unsafe {
        let c = &mut *(collection as *mut FonCollection);
        c.add(k, FonValue::IntArray(vec));
    }
    FON_OK
}


#[no_mangle]
pub extern "C" fn fon_collection_add_float_array(
    collection: *mut c_void,
    key: *const c_char,
    values: *const f32,
    count: i64,
    error: *mut FonError,
) -> i32 {
    if collection.is_null() || key.is_null() || values.is_null() || count < 0 {
        set_error(error, FON_ERROR_INVALID_ARGUMENT, "Invalid argument");
        return FON_ERROR_INVALID_ARGUMENT;
    }
    let k = match unsafe { cstr_to_str(key) } {
        Ok(s) => s.to_owned(),
        Err(e) => {
            set_error(error, FON_ERROR_INVALID_ARGUMENT, &e.to_string());
            return FON_ERROR_INVALID_ARGUMENT;
        }
    };
    let vec = unsafe { slice::from_raw_parts(values, count as usize).to_vec() };
    unsafe {
        let c = &mut *(collection as *mut FonCollection);
        c.add(k, FonValue::FloatArray(vec));
    }
    FON_OK
}


#[no_mangle]
pub extern "C" fn fon_collection_add_collection(
    parent: *mut c_void,
    key: *const c_char,
    child: *mut c_void,
    error: *mut FonError,
) -> i32 {
    if parent.is_null() || key.is_null() || child.is_null() {
        set_error(error, FON_ERROR_INVALID_ARGUMENT, "Invalid argument");
        return FON_ERROR_INVALID_ARGUMENT;
    }
    let k = match unsafe { cstr_to_str(key) } {
        Ok(s) => s.to_owned(),
        Err(e) => {
            set_error(error, FON_ERROR_INVALID_ARGUMENT, &e.to_string());
            return FON_ERROR_INVALID_ARGUMENT;
        }
    };
    unsafe {
        let p = &mut *(parent as *mut FonCollection);
        // Take ownership of child handle.
        let c = Box::from_raw(child as *mut FonCollection);
        p.add(k, FonValue::Object(c));
    }
    FON_OK
}


#[no_mangle]
pub extern "C" fn fon_collection_add_collection_array(
    parent: *mut c_void,
    key: *const c_char,
    children: *const *mut c_void,
    count: i64,
    error: *mut FonError,
) -> i32 {
    if parent.is_null() || key.is_null() || count < 0 || (count > 0 && children.is_null()) {
        set_error(error, FON_ERROR_INVALID_ARGUMENT, "Invalid argument");
        return FON_ERROR_INVALID_ARGUMENT;
    }
    let k = match unsafe { cstr_to_str(key) } {
        Ok(s) => s.to_owned(),
        Err(e) => {
            set_error(error, FON_ERROR_INVALID_ARGUMENT, &e.to_string());
            return FON_ERROR_INVALID_ARGUMENT;
        }
    };
    unsafe {
        let p = &mut *(parent as *mut FonCollection);
        let mut vec: Vec<Box<FonCollection>> = Vec::with_capacity(count as usize);
        let raw_children = slice::from_raw_parts(children, count as usize);
        for &handle in raw_children {
            // Take ownership of each child handle.
            vec.push(Box::from_raw(handle as *mut FonCollection));
        }
        p.add(k, FonValue::ObjectArray(vec));
    }
    FON_OK
}


// ==================== COLLECTION GET OPERATIONS ====================

#[no_mangle]
pub extern "C" fn fon_collection_get_int(
    collection: *mut c_void,
    key: *const c_char,
    value: *mut i32,
    error: *mut FonError,
) -> i32 {
    if collection.is_null() || key.is_null() || value.is_null() {
        set_error(error, FON_ERROR_INVALID_ARGUMENT, "Invalid argument");
        return FON_ERROR_INVALID_ARGUMENT;
    }
    unsafe {
        let c = &*(collection as *const FonCollection);
        let k = match cstr_to_str(key) {
            Ok(s) => s,
            Err(e) => {
                set_error(error, FON_ERROR_INVALID_ARGUMENT, &e.to_string());
                return FON_ERROR_INVALID_ARGUMENT;
            }
        };
        match c.get(k) {
            Some(FonValue::Int(v)) => {
                *value = *v;
                FON_OK
            }
            _ => {
                set_error(error, FON_ERROR_INVALID_ARGUMENT, "Key not found or wrong type");
                FON_ERROR_INVALID_ARGUMENT
            }
        }
    }
}


#[no_mangle]
pub extern "C" fn fon_collection_get_long(
    collection: *mut c_void,
    key: *const c_char,
    value: *mut i64,
    error: *mut FonError,
) -> i32 {
    if collection.is_null() || key.is_null() || value.is_null() {
        set_error(error, FON_ERROR_INVALID_ARGUMENT, "Invalid argument");
        return FON_ERROR_INVALID_ARGUMENT;
    }
    unsafe {
        let c = &*(collection as *const FonCollection);
        let k = match cstr_to_str(key) {
            Ok(s) => s,
            Err(e) => {
                set_error(error, FON_ERROR_INVALID_ARGUMENT, &e.to_string());
                return FON_ERROR_INVALID_ARGUMENT;
            }
        };
        match c.get(k) {
            Some(FonValue::Long(v)) => {
                *value = *v;
                FON_OK
            }
            _ => {
                set_error(error, FON_ERROR_INVALID_ARGUMENT, "Key not found or wrong type");
                FON_ERROR_INVALID_ARGUMENT
            }
        }
    }
}


#[no_mangle]
pub extern "C" fn fon_collection_get_float(
    collection: *mut c_void,
    key: *const c_char,
    value: *mut f32,
    error: *mut FonError,
) -> i32 {
    if collection.is_null() || key.is_null() || value.is_null() {
        set_error(error, FON_ERROR_INVALID_ARGUMENT, "Invalid argument");
        return FON_ERROR_INVALID_ARGUMENT;
    }
    unsafe {
        let c = &*(collection as *const FonCollection);
        let k = match cstr_to_str(key) {
            Ok(s) => s,
            Err(e) => {
                set_error(error, FON_ERROR_INVALID_ARGUMENT, &e.to_string());
                return FON_ERROR_INVALID_ARGUMENT;
            }
        };
        match c.get(k) {
            Some(FonValue::Float(v)) => {
                *value = *v;
                FON_OK
            }
            _ => {
                set_error(error, FON_ERROR_INVALID_ARGUMENT, "Key not found or wrong type");
                FON_ERROR_INVALID_ARGUMENT
            }
        }
    }
}


#[no_mangle]
pub extern "C" fn fon_collection_get_double(
    collection: *mut c_void,
    key: *const c_char,
    value: *mut f64,
    error: *mut FonError,
) -> i32 {
    if collection.is_null() || key.is_null() || value.is_null() {
        set_error(error, FON_ERROR_INVALID_ARGUMENT, "Invalid argument");
        return FON_ERROR_INVALID_ARGUMENT;
    }
    unsafe {
        let c = &*(collection as *const FonCollection);
        let k = match cstr_to_str(key) {
            Ok(s) => s,
            Err(e) => {
                set_error(error, FON_ERROR_INVALID_ARGUMENT, &e.to_string());
                return FON_ERROR_INVALID_ARGUMENT;
            }
        };
        match c.get(k) {
            Some(FonValue::Double(v)) => {
                *value = *v;
                FON_OK
            }
            _ => {
                set_error(error, FON_ERROR_INVALID_ARGUMENT, "Key not found or wrong type");
                FON_ERROR_INVALID_ARGUMENT
            }
        }
    }
}


#[no_mangle]
pub extern "C" fn fon_collection_get_bool(
    collection: *mut c_void,
    key: *const c_char,
    value: *mut i32,
    error: *mut FonError,
) -> i32 {
    if collection.is_null() || key.is_null() || value.is_null() {
        set_error(error, FON_ERROR_INVALID_ARGUMENT, "Invalid argument");
        return FON_ERROR_INVALID_ARGUMENT;
    }
    unsafe {
        let c = &*(collection as *const FonCollection);
        let k = match cstr_to_str(key) {
            Ok(s) => s,
            Err(e) => {
                set_error(error, FON_ERROR_INVALID_ARGUMENT, &e.to_string());
                return FON_ERROR_INVALID_ARGUMENT;
            }
        };
        match c.get(k) {
            Some(FonValue::Bool(v)) => {
                *value = if *v { 1 } else { 0 };
                FON_OK
            }
            _ => {
                set_error(error, FON_ERROR_INVALID_ARGUMENT, "Key not found or wrong type");
                FON_ERROR_INVALID_ARGUMENT
            }
        }
    }
}


#[no_mangle]
pub extern "C" fn fon_collection_get_string(
    collection: *mut c_void,
    key: *const c_char,
    buffer: *mut u8,
    buffer_size: i64,
    error: *mut FonError,
) -> i32 {
    if collection.is_null() || key.is_null() || buffer.is_null() || buffer_size <= 0 {
        set_error(error, FON_ERROR_INVALID_ARGUMENT, "Invalid argument");
        return FON_ERROR_INVALID_ARGUMENT;
    }
    unsafe {
        let c = &*(collection as *const FonCollection);
        let k = match cstr_to_str(key) {
            Ok(s) => s,
            Err(e) => {
                set_error(error, FON_ERROR_INVALID_ARGUMENT, &e.to_string());
                return FON_ERROR_INVALID_ARGUMENT;
            }
        };
        let s = match c.get(k) {
            Some(FonValue::String(s)) => s,
            _ => {
                set_error(error, FON_ERROR_INVALID_ARGUMENT, "Key not found or wrong type");
                return FON_ERROR_INVALID_ARGUMENT;
            }
        };

        let dst = slice::from_raw_parts_mut(buffer, buffer_size as usize);
        let bytes = s.as_bytes();
        let n = bytes.len().min(dst.len() - 1);
        dst[..n].copy_from_slice(&bytes[..n]);
        dst[n] = 0;
        FON_OK
    }
}


#[no_mangle]
pub extern "C" fn fon_collection_get_int_array(
    collection: *mut c_void,
    key: *const c_char,
    buffer: *mut i32,
    buffer_size: i64,
    actual_size: *mut i64,
    error: *mut FonError,
) -> i32 {
    if collection.is_null() || key.is_null() || actual_size.is_null() {
        set_error(error, FON_ERROR_INVALID_ARGUMENT, "Invalid argument");
        return FON_ERROR_INVALID_ARGUMENT;
    }
    unsafe {
        let c = &*(collection as *const FonCollection);
        let k = match cstr_to_str(key) {
            Ok(s) => s,
            Err(e) => {
                set_error(error, FON_ERROR_INVALID_ARGUMENT, &e.to_string());
                return FON_ERROR_INVALID_ARGUMENT;
            }
        };
        let arr = match c.get(k) {
            Some(FonValue::IntArray(v)) => v,
            _ => {
                set_error(error, FON_ERROR_INVALID_ARGUMENT, "Key not found or wrong type");
                return FON_ERROR_INVALID_ARGUMENT;
            }
        };
        *actual_size = arr.len() as i64;
        if !buffer.is_null() && buffer_size > 0 {
            let copy_count = (buffer_size as usize).min(arr.len());
            let dst = slice::from_raw_parts_mut(buffer, copy_count);
            dst.copy_from_slice(&arr[..copy_count]);
        }
        FON_OK
    }
}


#[no_mangle]
pub extern "C" fn fon_collection_get_float_array(
    collection: *mut c_void,
    key: *const c_char,
    buffer: *mut f32,
    buffer_size: i64,
    actual_size: *mut i64,
    error: *mut FonError,
) -> i32 {
    if collection.is_null() || key.is_null() || actual_size.is_null() {
        set_error(error, FON_ERROR_INVALID_ARGUMENT, "Invalid argument");
        return FON_ERROR_INVALID_ARGUMENT;
    }
    unsafe {
        let c = &*(collection as *const FonCollection);
        let k = match cstr_to_str(key) {
            Ok(s) => s,
            Err(e) => {
                set_error(error, FON_ERROR_INVALID_ARGUMENT, &e.to_string());
                return FON_ERROR_INVALID_ARGUMENT;
            }
        };
        let arr = match c.get(k) {
            Some(FonValue::FloatArray(v)) => v,
            _ => {
                set_error(error, FON_ERROR_INVALID_ARGUMENT, "Key not found or wrong type");
                return FON_ERROR_INVALID_ARGUMENT;
            }
        };
        *actual_size = arr.len() as i64;
        if !buffer.is_null() && buffer_size > 0 {
            let copy_count = (buffer_size as usize).min(arr.len());
            let dst = slice::from_raw_parts_mut(buffer, copy_count);
            dst.copy_from_slice(&arr[..copy_count]);
        }
        FON_OK
    }
}


#[no_mangle]
pub extern "C" fn fon_collection_get_collection(
    parent: *mut c_void,
    key: *const c_char,
    error: *mut FonError,
) -> *mut c_void {
    if parent.is_null() || key.is_null() {
        set_error(error, FON_ERROR_INVALID_ARGUMENT, "Invalid argument");
        return ptr::null_mut();
    }
    unsafe {
        let p = &mut *(parent as *mut FonCollection);
        let k = match cstr_to_str(key) {
            Ok(s) => s.to_owned(),
            Err(e) => {
                set_error(error, FON_ERROR_INVALID_ARGUMENT, &e.to_string());
                return ptr::null_mut();
            }
        };
        match p.get_mut(&k) {
            Some(FonValue::Object(boxed)) => {
                // Return borrowed pointer to the heap-allocated FonCollection inside the Box.
                // Stable as long as the parent FonCollection outlives the borrowed handle.
                let raw: *mut FonCollection = &mut **boxed;
                raw as *mut c_void
            }
            _ => {
                set_error(
                    error,
                    FON_ERROR_INVALID_ARGUMENT,
                    "Key not found or not a nested collection",
                );
                ptr::null_mut()
            }
        }
    }
}


#[no_mangle]
pub extern "C" fn fon_collection_get_collection_array(
    parent: *mut c_void,
    key: *const c_char,
    buffer: *mut *mut c_void,
    buffer_size: i64,
    actual_size: *mut i64,
    error: *mut FonError,
) -> i32 {
    if parent.is_null() || key.is_null() || actual_size.is_null() {
        set_error(error, FON_ERROR_INVALID_ARGUMENT, "Invalid argument");
        return FON_ERROR_INVALID_ARGUMENT;
    }
    unsafe {
        let p = &mut *(parent as *mut FonCollection);
        let k = match cstr_to_str(key) {
            Ok(s) => s.to_owned(),
            Err(e) => {
                set_error(error, FON_ERROR_INVALID_ARGUMENT, &e.to_string());
                return FON_ERROR_INVALID_ARGUMENT;
            }
        };
        let arr = match p.get_mut(&k) {
            Some(FonValue::ObjectArray(v)) => v,
            _ => {
                set_error(
                    error,
                    FON_ERROR_INVALID_ARGUMENT,
                    "Key not found or not an array of nested collections",
                );
                return FON_ERROR_INVALID_ARGUMENT;
            }
        };
        *actual_size = arr.len() as i64;
        if !buffer.is_null() && buffer_size > 0 {
            let copy_count = (buffer_size as usize).min(arr.len());
            let dst = slice::from_raw_parts_mut(buffer, copy_count);
            for (i, child) in arr.iter_mut().take(copy_count).enumerate() {
                let raw: *mut FonCollection = &mut **child;
                dst[i] = raw as *mut c_void;
            }
        }
        FON_OK
    }
}
