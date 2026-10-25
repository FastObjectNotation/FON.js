//! Dump handles: lifecycle, record ids, borrowed record lookup, put and remove,
//! and the generation counters that let callers validate borrowed views.

use std::ffi::c_void;
use std::ptr;

use fon::types::{FonCollection, FonDump};

use crate::error::{
    check_put, finish, invalid, slice_arg, to_i64, write_sized, Failure, FonError,
    FON_ERROR_NOT_FOUND,
};


pub(crate) unsafe fn dump_ref<'a>(handle: *mut c_void) -> Result<&'a FonDump, Failure> {
    if handle.is_null() {
        return Err(invalid("dump is null"));
    }
    Ok(&*(handle as *const FonDump))
}


pub(crate) unsafe fn dump_mut<'a>(handle: *mut c_void) -> Result<&'a mut FonDump, Failure> {
    if handle.is_null() {
        return Err(invalid("dump is null"));
    }
    Ok(&mut *(handle as *mut FonDump))
}


#[no_mangle]
pub extern "C" fn fon_dump_create() -> *mut c_void {
    Box::into_raw(Box::new(FonDump::new())).cast()
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
    match unsafe { dump_ref(dump) } {
        Ok(d) => to_i64(d.len()),
        Err(_) => 0,
    }
}


/// All live ids in ascending order (size-query pattern).
#[no_mangle]
pub extern "C" fn fon_dump_ids(
    dump: *mut c_void,
    buffer: *mut u64,
    capacity: i64,
    actual: *mut i64,
    error: *mut FonError,
) -> i32 {
    let result: Result<(), Failure> = unsafe { ids_into(dump, buffer, capacity, actual) };
    unsafe { finish(error, result) }
}


unsafe fn ids_into(
    dump: *mut c_void,
    buffer: *mut u64,
    capacity: i64,
    actual: *mut i64,
) -> Result<(), Failure> {
    let d: &FonDump = dump_ref(dump)?;
    let mut ids: Vec<u64> = d.iter().map(|(id, _)| id).collect();
    ids.sort_unstable();
    write_sized(ids.as_slice(), buffer, capacity, actual)
}


/// Borrowed record handle, NULL if absent. Valid only until the next mutation of the dump.
#[no_mangle]
pub extern "C" fn fon_dump_get(dump: *mut c_void, id: u64) -> *mut c_void {
    let record: Option<*mut FonCollection> = match unsafe { dump_mut(dump) } {
        Ok(d) => d.get_mut(id).map(|c| c as *mut FonCollection),
        Err(_) => None,
    };
    match record {
        Some(handle) => handle.cast(),
        None => ptr::null_mut(),
    }
}


/// Puts a record. Ownership of `collection` transfers to the dump iff FON_OK.
#[no_mangle]
pub extern "C" fn fon_dump_put(
    dump: *mut c_void,
    id: u64,
    collection: *mut c_void,
    mode: i32,
    error: *mut FonError,
) -> i32 {
    let result: Result<(), Failure> = unsafe { dump_put_into(dump, id, collection, mode) };
    unsafe { finish(error, result) }
}


unsafe fn dump_put_into(
    dump: *mut c_void,
    id: u64,
    collection: *mut c_void,
    mode: i32,
) -> Result<(), Failure> {
    let d: &mut FonDump = dump_mut(dump)?;
    let exists: bool = d.get(id).is_some();
    check_put(mode, exists, &format!("id {id}"))?;
    if collection.is_null() {
        return Err(invalid("collection is null"));
    }
    let child: Box<FonCollection> = Box::from_raw(collection as *mut FonCollection);
    if exists {
        // Unreachable failure: existence was checked above, so replace cannot fail.
        d.replace(id, *child)
            .map_err(|e| Failure::new(FON_ERROR_NOT_FOUND, e.to_string()))?;
    } else {
        d.add(id, *child);
    }
    Ok(())
}


#[no_mangle]
pub extern "C" fn fon_dump_remove(dump: *mut c_void, id: u64) -> i32 {
    match unsafe { dump_mut(dump) } {
        Ok(d) => i32::from(d.remove(id)),
        Err(_) => 0,
    }
}


/// Returns the number of live records removed. Absent and duplicate ids are ignored.
#[no_mangle]
pub extern "C" fn fon_dump_remove_many(dump: *mut c_void, ids: *const u64, count: i64) -> i64 {
    let result: Result<usize, Failure> = unsafe {
        dump_mut(dump).and_then(|d| slice_arg(ids, count).map(|list| d.remove_many(list)))
    };
    match result {
        Ok(removed) => to_i64(removed),
        Err(_) => 0,
    }
}


/// Writes the record and tree generations of `id`. Returns 1 if live, 0 if absent.
#[no_mangle]
pub extern "C" fn fon_dump_gens(
    dump: *mut c_void,
    id: u64,
    record_gen: *mut u32,
    tree_gen: *mut u32,
) -> i32 {
    if record_gen.is_null() || tree_gen.is_null() {
        return 0;
    }
    let Ok(d) = (unsafe { dump_ref(dump) }) else {
        return 0;
    };
    match (d.record_gen(id), d.tree_gen(id)) {
        (Some(record), Some(tree)) => {
            unsafe {
                ptr::write(record_gen, record);
                ptr::write(tree_gen, tree);
            }
            1
        }
        _ => 0,
    }
}


/// Bumps the tree generation of record `id` after a field-level mutation. 1 live, 0 absent.
#[no_mangle]
pub extern "C" fn fon_dump_touch(dump: *mut c_void, id: u64) -> i32 {
    match unsafe { dump_mut(dump) } {
        Ok(d) => i32::from(d.bump_tree_gen(id)),
        Err(_) => 0,
    }
}
