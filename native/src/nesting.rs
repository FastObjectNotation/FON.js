//! Nested collections: a single child object or an array of child objects.
//! A successful put transfers ownership of the child handle(s) into the parent;
//! a get returns borrowed handles owned by the parent.

use std::collections::HashSet;
use std::ffi::c_void;

use fon::types::{FonCollection, FonValue};

use crate::collection::{find_mut, put_field, type_mismatch};
use crate::error::{
    finish, handle_or_report, invalid, slice_arg, write_sized, Failure, FonError,
};


/// Validates a child handle and takes ownership of it. Runs only after the put
/// checks pass, so a rejected child is never consumed.
unsafe fn take_child(child: *mut c_void, target: *mut c_void) -> Result<FonValue, Failure> {
    if child.is_null() {
        return Err(invalid("child collection is null"));
    }
    if child == target {
        return Err(invalid("a collection cannot be put into itself"));
    }
    Ok(FonValue::Object(Box::from_raw(child as *mut FonCollection)))
}


/// Validates an array of child handles and takes ownership of all of them.
unsafe fn take_children(
    children: *const *mut c_void,
    count: i64,
    target: *mut c_void,
) -> Result<FonValue, Failure> {
    let handles: &[*mut c_void] = slice_arg(children, count)?;
    let mut seen: HashSet<usize> = HashSet::with_capacity(handles.len());
    for &handle in handles {
        if handle.is_null() {
            return Err(invalid("child collection is null"));
        }
        if handle == target {
            return Err(invalid("a collection cannot be put into itself"));
        }
        if !seen.insert(handle as usize) {
            return Err(invalid("the same child collection appears twice"));
        }
    }
    let boxes: Vec<Box<FonCollection>> = handles
        .iter()
        .map(|&handle| Box::from_raw(handle as *mut FonCollection))
        .collect();
    Ok(FonValue::ObjectArray(boxes))
}


#[no_mangle]
pub extern "C" fn fon_collection_put_collection(
    collection: *mut c_void,
    key: *const u8,
    key_len: i64,
    child: *mut c_void,
    mode: i32,
    error: *mut FonError,
) -> i32 {
    let result: Result<(), Failure> = unsafe {
        put_field(collection, key, key_len, mode, || take_child(child, collection))
    };
    unsafe { finish(error, result) }
}


#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn fon_collection_put_collection_array(
    collection: *mut c_void,
    key: *const u8,
    key_len: i64,
    children: *const *mut c_void,
    count: i64,
    mode: i32,
    error: *mut FonError,
) -> i32 {
    let result: Result<(), Failure> = unsafe {
        put_field(collection, key, key_len, mode, || take_children(children, count, collection))
    };
    unsafe { finish(error, result) }
}


/// Returns a borrowed handle to the nested collection under `key`.
#[no_mangle]
pub extern "C" fn fon_collection_get_collection(
    collection: *mut c_void,
    key: *const u8,
    key_len: i64,
    error: *mut FonError,
) -> *mut c_void {
    let result: Result<*mut c_void, Failure> =
        unsafe { borrowed_child(collection, key, key_len) };
    unsafe { handle_or_report(error, result) }
}


unsafe fn borrowed_child(
    collection: *mut c_void,
    key: *const u8,
    key_len: i64,
) -> Result<*mut c_void, Failure> {
    let (name, value) = find_mut(collection, key, key_len)?;
    match value {
        FonValue::Object(child) => Ok(&mut **child as *mut FonCollection as *mut c_void),
        other => Err(type_mismatch(name, other, "collection")),
    }
}


/// Writes borrowed handles of the nested collections under `key` (size-query pattern).
#[no_mangle]
pub extern "C" fn fon_collection_get_collection_array(
    collection: *mut c_void,
    key: *const u8,
    key_len: i64,
    buffer: *mut *mut c_void,
    capacity: i64,
    actual: *mut i64,
    error: *mut FonError,
) -> i32 {
    let result: Result<(), Failure> = unsafe { collection_array_into(collection, key, key_len, buffer, capacity, actual) };
    unsafe { finish(error, result) }
}


#[allow(clippy::too_many_arguments)]
unsafe fn collection_array_into(
    collection: *mut c_void,
    key: *const u8,
    key_len: i64,
    buffer: *mut *mut c_void,
    capacity: i64,
    actual: *mut i64,
) -> Result<(), Failure> {
    let (name, value) = find_mut(collection, key, key_len)?;
    match value {
        FonValue::ObjectArray(children) => {
            let handles: Vec<*mut c_void> = children
                .iter_mut()
                .map(|child| &mut **child as *mut FonCollection as *mut c_void)
                .collect();
            write_sized(handles.as_slice(), buffer, capacity, actual)
        }
        other => Err(type_mismatch(name, other, "collection array")),
    }
}
