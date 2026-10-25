//! Collection handles: lifecycle, introspection, key enumeration and removal,
//! plus the lookup and put helpers the typed modules build on.

use std::ffi::c_void;
use std::slice;

use fon::types::{
    FonCollection, FonValue, TYPE_BOOL, TYPE_BYTE, TYPE_DOUBLE, TYPE_FLOAT, TYPE_INT, TYPE_LONG,
    validate_key, TYPE_OBJECT, TYPE_RAW, TYPE_SHORT, TYPE_STRING, TYPE_UINT, TYPE_ULONG,
};

use crate::error::{
    check_put, finish, handle_or_report, invalid, str_arg, to_i64, write_multi, Failure,
    FonError, FON_ERROR_NOT_FOUND, FON_ERROR_TYPE_MISMATCH,
};


/// Kind flag for array values (bit 8 of the packed kind).
pub const FON_KIND_ARRAY: i32 = 0x100;


pub(crate) unsafe fn collection_ref<'a>(handle: *mut c_void) -> Result<&'a FonCollection, Failure> {
    if handle.is_null() {
        return Err(invalid("collection is null"));
    }
    Ok(&*(handle as *const FonCollection))
}


pub(crate) unsafe fn collection_mut<'a>(
    handle: *mut c_void,
) -> Result<&'a mut FonCollection, Failure> {
    if handle.is_null() {
        return Err(invalid("collection is null"));
    }
    Ok(&mut *(handle as *mut FonCollection))
}


pub(crate) fn value_kind(value: &FonValue) -> (u8, bool) {
    match value {
        FonValue::Byte(_) => (TYPE_BYTE, false),
        FonValue::Short(_) => (TYPE_SHORT, false),
        FonValue::Int(_) => (TYPE_INT, false),
        FonValue::UInt(_) => (TYPE_UINT, false),
        FonValue::Long(_) => (TYPE_LONG, false),
        FonValue::ULong(_) => (TYPE_ULONG, false),
        FonValue::Float(_) => (TYPE_FLOAT, false),
        FonValue::Double(_) => (TYPE_DOUBLE, false),
        FonValue::Bool(_) => (TYPE_BOOL, false),
        FonValue::String(_) => (TYPE_STRING, false),
        FonValue::Raw(_) => (TYPE_RAW, false),
        FonValue::Object(_) => (TYPE_OBJECT, false),
        FonValue::ByteArray(_) => (TYPE_BYTE, true),
        FonValue::ShortArray(_) => (TYPE_SHORT, true),
        FonValue::IntArray(_) => (TYPE_INT, true),
        FonValue::UIntArray(_) => (TYPE_UINT, true),
        FonValue::LongArray(_) => (TYPE_LONG, true),
        FonValue::ULongArray(_) => (TYPE_ULONG, true),
        FonValue::FloatArray(_) => (TYPE_FLOAT, true),
        FonValue::DoubleArray(_) => (TYPE_DOUBLE, true),
        FonValue::BoolArray(_) => (TYPE_BOOL, true),
        FonValue::StringArray(_) => (TYPE_STRING, true),
        FonValue::ObjectArray(_) => (TYPE_OBJECT, true),
    }
}


pub(crate) fn pack_kind(type_char: u8, is_array: bool) -> i32 {
    let base: i32 = i32::from(type_char);
    if is_array {
        base | FON_KIND_ARRAY
    } else {
        base
    }
}


pub(crate) fn type_label(type_char: u8) -> &'static str {
    match type_char {
        TYPE_BYTE => "byte",
        TYPE_SHORT => "short",
        TYPE_INT => "int",
        TYPE_UINT => "uint",
        TYPE_LONG => "long",
        TYPE_ULONG => "ulong",
        TYPE_FLOAT => "float",
        TYPE_DOUBLE => "double",
        TYPE_BOOL => "bool",
        TYPE_STRING => "string",
        TYPE_RAW => "raw",
        TYPE_OBJECT => "collection",
        _ => "unknown",
    }
}


pub(crate) fn describe(value: &FonValue) -> String {
    let (type_char, is_array): (u8, bool) = value_kind(value);
    let label: &str = type_label(type_char);
    if is_array {
        format!("{label} array")
    } else {
        label.to_string()
    }
}


pub(crate) fn key_not_found(key: &str) -> Failure {
    Failure::new(FON_ERROR_NOT_FOUND, format!("key '{key}' not found"))
}


pub(crate) fn type_mismatch(key: &str, value: &FonValue, expected: &str) -> Failure {
    Failure::new(
        FON_ERROR_TYPE_MISMATCH,
        format!("key '{key}' is {}, not {expected}", describe(value)),
    )
}


/// Resolves a key to its value, borrowed for `'a`.
pub(crate) unsafe fn find_ref<'a>(
    handle: *mut c_void,
    key: *const u8,
    key_len: i64,
) -> Result<(&'a str, &'a FonValue), Failure> {
    let collection: &'a FonCollection = collection_ref(handle)?;
    let name: &'a str = str_arg(key, key_len)?;
    match collection.get(name) {
        Some(value) => Ok((name, value)),
        None => Err(key_not_found(name)),
    }
}


/// Resolves a key to its value for in-place mutation (borrowed nested handles).
pub(crate) unsafe fn find_mut<'a>(
    handle: *mut c_void,
    key: *const u8,
    key_len: i64,
) -> Result<(&'a str, &'a mut FonValue), Failure> {
    let collection: &'a mut FonCollection = collection_mut(handle)?;
    let name: &'a str = str_arg(key, key_len)?;
    match collection.get_mut(name) {
        Some(value) => Ok((name, value)),
        None => Err(key_not_found(name)),
    }
}


/// Looks a key up and lets `pick` select the wanted variant. A different variant
/// yields `TYPE_MISMATCH`; an absent key yields `NOT_FOUND`.
pub(crate) unsafe fn read_as<'a, T>(
    handle: *mut c_void,
    key: *const u8,
    key_len: i64,
    expected: &str,
    pick: impl FnOnce(&'a FonValue) -> Option<T>,
) -> Result<T, Failure> {
    let (name, value): (&'a str, &'a FonValue) = find_ref(handle, key, key_len)?;
    match pick(value) {
        Some(picked) => Ok(picked),
        None => Err(type_mismatch(name, value, expected)),
    }
}


/// Shared put path for every value family. `make` runs only after the target,
/// key, mode and existence checks pass, so it may consume a child handle; once
/// it returns, the insertion below cannot fail.
pub(crate) unsafe fn put_field(
    handle: *mut c_void,
    key: *const u8,
    key_len: i64,
    mode: i32,
    make: impl FnOnce() -> Result<FonValue, Failure>,
) -> Result<(), Failure> {
    let collection: &mut FonCollection = collection_mut(handle)?;
    let name: &str = str_arg(key, key_len)?;
    let exists: bool = collection.get(name).is_some();
    check_put(mode, exists, &format!("key '{name}'"))?;
    if !exists {
        validate_key(name).map_err(|e| invalid(e.to_string()))?;
    }
    let value: FonValue = make()?;
    if exists {
        if let Some(slot) = collection.get_mut(name) {
            *slot = value;
        }
    } else {
        collection.add(name, value);
    }
    Ok(())
}


#[no_mangle]
pub extern "C" fn fon_collection_create() -> *mut c_void {
    Box::into_raw(Box::new(FonCollection::new())).cast()
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
    match unsafe { collection_ref(collection) } {
        Ok(c) => to_i64(c.len()),
        Err(_) => 0,
    }
}


#[no_mangle]
pub extern "C" fn fon_collection_clone(collection: *mut c_void, error: *mut FonError) -> *mut c_void {
    let result: Result<*mut c_void, Failure> = unsafe {
        collection_ref(collection).map(|c| Box::into_raw(Box::new(c.clone())).cast())
    };
    unsafe { handle_or_report(error, result) }
}


#[no_mangle]
pub extern "C" fn fon_collection_kind_of(collection: *mut c_void, key: *const u8, key_len: i64) -> i32 {
    match unsafe { find_ref(collection, key, key_len) } {
        Ok((_, value)) => {
            let (type_char, is_array): (u8, bool) = value_kind(value);
            pack_kind(type_char, is_array)
        }
        Err(_) => -1,
    }
}


#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn fon_collection_keys(
    collection: *mut c_void,
    lengths: *mut i64,
    lengths_capacity: i64,
    bytes: *mut u8,
    bytes_capacity: i64,
    kinds: *mut i32,
    count: *mut i64,
    total_bytes: *mut i64,
    error: *mut FonError,
) -> i32 {
    let result: Result<(), Failure> = unsafe {
        keys_into(
            collection,
            lengths,
            lengths_capacity,
            bytes,
            bytes_capacity,
            kinds,
            count,
            total_bytes,
        )
    };
    unsafe { finish(error, result) }
}


#[allow(clippy::too_many_arguments)]
unsafe fn keys_into(
    collection: *mut c_void,
    lengths: *mut i64,
    lengths_capacity: i64,
    bytes: *mut u8,
    bytes_capacity: i64,
    kinds: *mut i32,
    count: *mut i64,
    total_bytes: *mut i64,
) -> Result<(), Failure> {
    let c: &FonCollection = collection_ref(collection)?;
    let keys: Vec<&[u8]> = c.iter().map(|(key, _)| key.as_bytes()).collect();
    let written: bool = write_multi(
        &keys,
        lengths,
        lengths_capacity,
        bytes,
        bytes_capacity,
        count,
        total_bytes,
    )?;
    if written && !kinds.is_null() {
        let out: &mut [i32] = slice::from_raw_parts_mut(kinds, keys.len());
        for (slot, (_, value)) in out.iter_mut().zip(c.iter()) {
            let (type_char, is_array): (u8, bool) = value_kind(value);
            *slot = pack_kind(type_char, is_array);
        }
    }
    Ok(())
}


#[no_mangle]
pub extern "C" fn fon_collection_remove(collection: *mut c_void, key: *const u8, key_len: i64) -> i32 {
    let result: Result<bool, Failure> = unsafe {
        collection_mut(collection).and_then(|c| str_arg(key, key_len).map(|name| c.remove_field(name)))
    };
    match result {
        Ok(removed) => i32::from(removed),
        Err(_) => 0,
    }
}
