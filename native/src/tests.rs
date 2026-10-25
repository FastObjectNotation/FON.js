//! Shim tests. They call the exported `extern "C"` functions directly, the way a
//! binding does, and cover every function family, put mode, result code and
//! size-query edge case.

use std::ffi::{c_void, CStr};
use std::fs;
use std::ptr;

use fon::types::{TYPE_BOOL, TYPE_INT, TYPE_STRING};

use crate::array::*;
use crate::collection::*;
use crate::config::*;
use crate::deserialize::*;
use crate::dump::*;
use crate::error::*;
use crate::nesting::*;
use crate::scalar::*;
use crate::serialize::*;


fn new_error() -> FonError {
    FonError {
        code: FON_OK,
        message: [0; 256],
    }
}


fn message_of(error: &FonError) -> String {
    let end: usize = error
        .message
        .iter()
        .position(|&b| b == 0)
        .unwrap_or(error.message.len());
    String::from_utf8_lossy(&error.message[..end]).into_owned()
}


fn key(name: &str) -> (*const u8, i64) {
    (name.as_ptr(), to_i64(name.len()))
}


fn put_int(collection: *mut c_void, name: &str, value: i32, mode: i32) -> i32 {
    let (k, kl): (*const u8, i64) = key(name);
    fon_collection_put_int(collection, k, kl, value, mode, &mut new_error())
}


fn put_string(collection: *mut c_void, name: &str, value: &str, mode: i32) -> i32 {
    let (k, kl): (*const u8, i64) = key(name);
    fon_collection_put_string(
        collection,
        k,
        kl,
        value.as_ptr(),
        to_i64(value.len()),
        mode,
        &mut new_error(),
    )
}


/// Reads a string value with the two-call size-query pattern.
fn read_string(collection: *mut c_void, name: &str) -> Result<String, i32> {
    let (k, kl): (*const u8, i64) = key(name);
    let mut error: FonError = new_error();
    let mut needed: i64 = 0;
    let code: i32 = fon_collection_get_string(
        collection,
        k,
        kl,
        ptr::null_mut(),
        0,
        &mut needed,
        &mut error,
    );
    if code != FON_OK {
        return Err(code);
    }
    let mut buffer: Vec<u8> = vec![0; needed as usize];
    let code: i32 = fon_collection_get_string(
        collection,
        k,
        kl,
        buffer.as_mut_ptr(),
        needed,
        &mut needed,
        &mut error,
    );
    if code != FON_OK {
        return Err(code);
    }
    Ok(String::from_utf8(buffer).unwrap_or_default())
}


fn read_int(collection: *mut c_void, name: &str) -> Result<i32, i32> {
    let (k, kl): (*const u8, i64) = key(name);
    let mut value: i32 = 0;
    let code: i32 = fon_collection_get_int(collection, k, kl, &mut value, &mut new_error());
    if code == FON_OK {
        Ok(value)
    } else {
        Err(code)
    }
}


/// Returns the keys of a collection in order, read with the multi-string pattern.
fn read_keys(collection: *mut c_void) -> (Vec<String>, Vec<i32>) {
    let mut count: i64 = 0;
    let mut total: i64 = 0;
    let code: i32 = fon_collection_keys(
        collection,
        ptr::null_mut(),
        0,
        ptr::null_mut(),
        0,
        ptr::null_mut(),
        &mut count,
        &mut total,
        &mut new_error(),
    );
    assert_eq!(code, FON_OK);
    let mut lengths: Vec<i64> = vec![0; count as usize];
    let mut bytes: Vec<u8> = vec![0; total as usize];
    let mut kinds: Vec<i32> = vec![0; count as usize];
    let code: i32 = fon_collection_keys(
        collection,
        lengths.as_mut_ptr(),
        count,
        bytes.as_mut_ptr(),
        total,
        kinds.as_mut_ptr(),
        &mut count,
        &mut total,
        &mut new_error(),
    );
    assert_eq!(code, FON_OK);
    let mut keys: Vec<String> = Vec::new();
    let mut offset: usize = 0;
    for length in lengths {
        let end: usize = offset + length as usize;
        keys.push(String::from_utf8(bytes[offset..end].to_vec()).unwrap_or_default());
        offset = end;
    }
    (keys, kinds)
}


fn dump_ids(dump: *mut c_void) -> Vec<u64> {
    let mut needed: i64 = 0;
    let code: i32 = fon_dump_ids(dump, ptr::null_mut(), 0, &mut needed, &mut new_error());
    assert_eq!(code, FON_OK);
    let mut ids: Vec<u64> = vec![0; needed as usize];
    let code: i32 = fon_dump_ids(dump, ids.as_mut_ptr(), needed, &mut needed, &mut new_error());
    assert_eq!(code, FON_OK);
    ids
}


#[test]
fn version_is_nul_terminated_and_matches_package() {
    let version: &CStr = unsafe { CStr::from_ptr(fon_version()) };
    assert_eq!(version.to_str().unwrap_or_default(), env!("CARGO_PKG_VERSION"));
}


#[test]
fn scalars_round_trip_with_extremes() {
    let c: *mut c_void = fon_collection_create();
    let (k, kl): (*const u8, i64) = key("b");
    assert_eq!(fon_collection_put_byte(c, k, kl, u8::MAX, FON_PUT_ADD, &mut new_error()), FON_OK);
    let (k, kl) = key("s");
    assert_eq!(fon_collection_put_short(c, k, kl, i16::MIN, FON_PUT_ADD, &mut new_error()), FON_OK);
    let (k, kl) = key("u");
    assert_eq!(fon_collection_put_uint(c, k, kl, u32::MAX, FON_PUT_ADD, &mut new_error()), FON_OK);
    let (k, kl) = key("l");
    assert_eq!(fon_collection_put_long(c, k, kl, i64::MIN, FON_PUT_ADD, &mut new_error()), FON_OK);
    let (k, kl) = key("g");
    assert_eq!(fon_collection_put_ulong(c, k, kl, u64::MAX, FON_PUT_ADD, &mut new_error()), FON_OK);
    let (k, kl) = key("f");
    assert_eq!(fon_collection_put_float(c, k, kl, f32::NEG_INFINITY, FON_PUT_ADD, &mut new_error()), FON_OK);
    let (k, kl) = key("d");
    assert_eq!(fon_collection_put_double(c, k, kl, f64::NAN, FON_PUT_ADD, &mut new_error()), FON_OK);
    let (k, kl) = key("t");
    assert_eq!(fon_collection_put_bool(c, k, kl, 7, FON_PUT_ADD, &mut new_error()), FON_OK);
    assert_eq!(put_int(c, "i", i32::MIN, FON_PUT_ADD), FON_OK);

    let (k, kl) = key("b");
    let mut byte: u8 = 0;
    assert_eq!(fon_collection_get_byte(c, k, kl, &mut byte, &mut new_error()), FON_OK);
    assert_eq!(byte, u8::MAX);
    let (k, kl) = key("s");
    let mut short: i16 = 0;
    assert_eq!(fon_collection_get_short(c, k, kl, &mut short, &mut new_error()), FON_OK);
    assert_eq!(short, i16::MIN);
    let (k, kl) = key("u");
    let mut uint: u32 = 0;
    assert_eq!(fon_collection_get_uint(c, k, kl, &mut uint, &mut new_error()), FON_OK);
    assert_eq!(uint, u32::MAX);
    let (k, kl) = key("l");
    let mut long: i64 = 0;
    assert_eq!(fon_collection_get_long(c, k, kl, &mut long, &mut new_error()), FON_OK);
    assert_eq!(long, i64::MIN);
    let (k, kl) = key("g");
    let mut ulong: u64 = 0;
    assert_eq!(fon_collection_get_ulong(c, k, kl, &mut ulong, &mut new_error()), FON_OK);
    assert_eq!(ulong, u64::MAX);
    let (k, kl) = key("f");
    let mut float: f32 = 0.0;
    assert_eq!(fon_collection_get_float(c, k, kl, &mut float, &mut new_error()), FON_OK);
    assert!(float.is_infinite() && float < 0.0);
    let (k, kl) = key("d");
    let mut double: f64 = 0.0;
    assert_eq!(fon_collection_get_double(c, k, kl, &mut double, &mut new_error()), FON_OK);
    assert!(double.is_nan());
    let (k, kl) = key("t");
    let mut flag: i32 = -1;
    assert_eq!(fon_collection_get_bool(c, k, kl, &mut flag, &mut new_error()), FON_OK);
    assert_eq!(flag, 1);
    assert_eq!(read_int(c, "i"), Ok(i32::MIN));

    fon_collection_free(c);
}


#[test]
fn kind_of_reports_type_and_array_flag() {
    let c: *mut c_void = fon_collection_create();
    assert_eq!(put_int(c, "i", 1, FON_PUT_ADD), FON_OK);
    assert_eq!(put_string(c, "s", "x", FON_PUT_ADD), FON_OK);
    let (k, kl) = key("flags");
    assert_eq!(fon_collection_put_bool_array(c, k, kl, [1u8, 0].as_ptr(), 2, FON_PUT_ADD, &mut new_error()), FON_OK);
    let (k, kl) = key("i");
    assert_eq!(fon_collection_kind_of(c, k, kl), i32::from(TYPE_INT));
    let (k, kl) = key("s");
    assert_eq!(fon_collection_kind_of(c, k, kl), i32::from(TYPE_STRING));
    let (k, kl) = key("flags");
    assert_eq!(fon_collection_kind_of(c, k, kl), i32::from(TYPE_BOOL) | FON_KIND_ARRAY);
    let (k, kl) = key("absent");
    assert_eq!(fon_collection_kind_of(c, k, kl), -1);
    fon_collection_free(c);
}


#[test]
fn bool_values_normalise_to_zero_or_one() {
    let c: *mut c_void = fon_collection_create();
    let (k, kl) = key("yes");
    assert_eq!(fon_collection_put_bool(c, k, kl, -5, FON_PUT_ADD, &mut new_error()), FON_OK);
    let (k, kl) = key("no");
    assert_eq!(fon_collection_put_bool(c, k, kl, 0, FON_PUT_ADD, &mut new_error()), FON_OK);
    let (k, kl) = key("yes");
    let mut value: i32 = 9;
    assert_eq!(fon_collection_get_bool(c, k, kl, &mut value, &mut new_error()), FON_OK);
    assert_eq!(value, 1);
    let (k, kl) = key("no");
    assert_eq!(fon_collection_get_bool(c, k, kl, &mut value, &mut new_error()), FON_OK);
    assert_eq!(value, 0);
    fon_collection_free(c);
}


#[test]
fn strings_keep_every_byte() {
    let c: *mut c_void = fon_collection_create();
    let long_value: String = "b".repeat(100_000);
    let exact_8192: String = "a".repeat(8192);
    let cyrillic: String = "ж".repeat(5000);
    let emoji: String = "😀".repeat(2500);
    let samples: Vec<(&str, String)> = vec![
        ("n8191", "a".repeat(8191)),
        ("n8192", exact_8192.clone()),
        ("n100k", long_value.clone()),
        ("cyr", cyrillic.clone()),
        ("emoji", emoji.clone()),
        ("nul", "x\0y\0".to_string()),
        ("backslash", "C:\\dir\\".to_string()),
        ("controls", "\u{1}\u{1b}\n\t".to_string()),
        ("empty", String::new()),
        ("quotes", "a\",b}{[]c".to_string()),
    ];
    for (name, value) in &samples {
        assert_eq!(put_string(c, name, value, FON_PUT_ADD), FON_OK, "put {name}");
    }
    for (name, value) in &samples {
        assert_eq!(read_string(c, name), Ok(value.clone()), "get {name}");
    }
    fon_collection_free(c);
}


#[test]
fn keys_with_nul_and_long_keys_round_trip() {
    let c: *mut c_void = fon_collection_create();
    let long_key: String = "k".repeat(600);
    let nul_key: String = "a\0b".to_string();
    assert_eq!(put_int(c, &long_key, 1, FON_PUT_ADD), FON_OK);
    assert_eq!(put_int(c, &nul_key, 2, FON_PUT_ADD), FON_OK);
    let (keys, _) = read_keys(c);
    assert_eq!(keys, vec![long_key.clone(), nul_key.clone()]);
    assert_eq!(read_int(c, &long_key), Ok(1));
    assert_eq!(read_int(c, &nul_key), Ok(2));
    fon_collection_free(c);
}


#[test]
fn size_query_never_truncates() {
    let c: *mut c_void = fon_collection_create();
    assert_eq!(put_string(c, "s", "abcdefghij", FON_PUT_ADD), FON_OK);
    let (k, kl) = key("s");
    let mut needed: i64 = -1;
    assert_eq!(
        fon_collection_get_string(c, k, kl, ptr::null_mut(), 0, &mut needed, &mut new_error()),
        FON_OK
    );
    assert_eq!(needed, 10);

    let mut sentinel: [u8; 10] = [0xAA; 10];
    let mut error: FonError = new_error();
    let code: i32 = fon_collection_get_string(c, k, kl, sentinel.as_mut_ptr(), 9, &mut needed, &mut error);
    assert_eq!(code, FON_ERROR_BUFFER_TOO_SMALL);
    assert_eq!(needed, 10);
    assert_eq!(sentinel, [0xAA; 10]);

    let code: i32 = fon_collection_get_string(c, k, kl, sentinel.as_mut_ptr(), 10, &mut needed, &mut error);
    assert_eq!(code, FON_OK);
    assert_eq!(&sentinel, b"abcdefghij");
    fon_collection_free(c);
}


#[test]
fn negative_capacities_are_invalid_arguments() {
    let c: *mut c_void = fon_collection_create();
    assert_eq!(put_string(c, "empty", "", FON_PUT_ADD), FON_OK);
    assert_eq!(put_string(c, "text", "abc", FON_PUT_ADD), FON_OK);
    let ints: [i32; 2] = [1, 2];
    let (k, kl) = key("ints");
    assert_eq!(fon_collection_put_int_array(c, k, kl, ints.as_ptr(), 2, FON_PUT_ADD, &mut new_error()), FON_OK);
    let list: [i64; 1] = [1];
    let payload: [u8; 1] = [b'x'];
    let (k, kl) = key("list");
    assert_eq!(
        fon_collection_put_string_array(c, k, kl, list.as_ptr(), payload.as_ptr(), 1, FON_PUT_ADD, &mut new_error()),
        FON_OK
    );

    let mut sentinel: [u8; 4] = [0xAA; 4];
    let mut needed: i64 = -1;
    let mut error: FonError = new_error();

    let (k, kl) = key("empty");
    let code: i32 = fon_collection_get_string(c, k, kl, sentinel.as_mut_ptr(), -1, &mut needed, &mut error);
    assert_eq!(code, FON_ERROR_INVALID_ARGUMENT);
    assert_eq!(sentinel, [0xAA; 4]);

    let (k, kl) = key("text");
    let code: i32 = fon_collection_get_string(c, k, kl, sentinel.as_mut_ptr(), -1, &mut needed, &mut error);
    assert_eq!(code, FON_ERROR_INVALID_ARGUMENT);
    assert_eq!(sentinel, [0xAA; 4]);

    let mut int_out: [i32; 2] = [0; 2];
    let (k, kl) = key("ints");
    let code: i32 = fon_collection_get_int_array(c, k, kl, int_out.as_mut_ptr(), -1, &mut needed, &mut error);
    assert_eq!(code, FON_ERROR_INVALID_ARGUMENT);
    assert_eq!(int_out, [0; 2]);

    let mut lengths_out: [i64; 1] = [-1];
    let mut bytes_out: [u8; 1] = [0];
    let mut count: i64 = 0;
    let mut total: i64 = 0;
    let (k, kl) = key("list");
    let code: i32 = fon_collection_get_string_array(
        c,
        k,
        kl,
        lengths_out.as_mut_ptr(),
        -1,
        bytes_out.as_mut_ptr(),
        1,
        &mut count,
        &mut total,
        &mut error,
    );
    assert_eq!(code, FON_ERROR_INVALID_ARGUMENT);
    assert_eq!(lengths_out, [-1]);

    let code: i32 = fon_collection_get_string_array(
        c,
        k,
        kl,
        lengths_out.as_mut_ptr(),
        1,
        bytes_out.as_mut_ptr(),
        -1,
        &mut count,
        &mut total,
        &mut error,
    );
    assert_eq!(code, FON_ERROR_INVALID_ARGUMENT);
    assert_eq!(bytes_out, [0]);

    let mut key_lengths: [i64; 1] = [-1];
    let mut key_bytes: [u8; 3] = [0; 3];
    let mut kinds: [i32; 1] = [0];
    let code: i32 = fon_collection_keys(
        c,
        key_lengths.as_mut_ptr(),
        -1,
        key_bytes.as_mut_ptr(),
        3,
        kinds.as_mut_ptr(),
        &mut count,
        &mut total,
        &mut error,
    );
    assert_eq!(code, FON_ERROR_INVALID_ARGUMENT);
    assert_eq!(key_lengths, [-1]);

    let blank: *mut c_void = fon_collection_create();
    let code: i32 = fon_collection_keys(
        blank,
        key_lengths.as_mut_ptr(),
        1,
        key_bytes.as_mut_ptr(),
        -1,
        kinds.as_mut_ptr(),
        &mut count,
        &mut total,
        &mut error,
    );
    assert_eq!(code, FON_ERROR_INVALID_ARGUMENT);
    assert_eq!(count, 0);
    fon_collection_free(blank);

    let (k, kl) = key("empty");
    let mut needed_empty: i64 = -1;
    let size_code: i32 = fon_collection_get_string(c, k, kl, ptr::null_mut(), -1, &mut needed_empty, &mut error);
    assert_eq!(size_code, FON_OK);
    assert_eq!(needed_empty, 0);
    fon_collection_free(c);
}


#[test]
fn put_modes_and_their_codes() {
    let c: *mut c_void = fon_collection_create();
    let mut error: FonError = new_error();
    let (k, kl) = key("n");
    assert_eq!(fon_collection_put_int(c, k, kl, 1, FON_PUT_ADD, &mut error), FON_OK);

    let code: i32 = fon_collection_put_int(c, k, kl, 2, FON_PUT_ADD, &mut error);
    assert_eq!(code, FON_ERROR_ALREADY_EXISTS);
    assert!(message_of(&error).contains("key 'n' already exists"));

    let (missing, missing_len) = key("missing");
    let code: i32 = fon_collection_put_int(c, missing, missing_len, 2, FON_PUT_SET, &mut error);
    assert_eq!(code, FON_ERROR_NOT_FOUND);
    assert!(message_of(&error).contains("key 'missing' not found"));

    assert_eq!(fon_collection_put_int(c, k, kl, 3, FON_PUT_SET, &mut error), FON_OK);
    assert_eq!(read_int(c, "n"), Ok(3));

    // SET may change the type of the value.
    assert_eq!(put_string(c, "n", "now text", FON_PUT_SET), FON_OK);
    assert_eq!(read_string(c, "n"), Ok("now text".to_string()));

    assert_eq!(put_int(c, "u", 5, FON_PUT_UPSERT), FON_OK);
    assert_eq!(put_int(c, "u", 6, FON_PUT_UPSERT), FON_OK);
    assert_eq!(read_int(c, "u"), Ok(6));

    assert_eq!(put_int(c, "u", 6, 42), FON_ERROR_INVALID_ARGUMENT);
    fon_collection_free(c);
}


#[test]
fn keys_that_cannot_round_trip_are_rejected_before_taking_ownership() {
    let c: *mut c_void = fon_collection_create();
    for name in ["a=b", "a\"b", "a{b", "a}b", "a[b", "a]b", "a\nb", "a\rb"] {
        assert_eq!(put_int(c, name, 1, FON_PUT_UPSERT), FON_ERROR_INVALID_ARGUMENT, "key {name:?}");
    }
    assert_eq!(fon_collection_size(c), 0);

    // A rejected child stays owned by the caller, so freeing it here must be the only free.
    let child: *mut c_void = fon_collection_create();
    let (k, kl) = key("x{");
    assert_eq!(fon_collection_put_collection(c, k, kl, child, FON_PUT_ADD, &mut new_error()), FON_ERROR_INVALID_ARGUMENT);
    fon_collection_free(child);
    fon_collection_free(c);
}


#[test]
fn getters_report_not_found_and_type_mismatch() {
    let c: *mut c_void = fon_collection_create();
    assert_eq!(put_string(c, "text", "x", FON_PUT_ADD), FON_OK);
    let (k, kl) = key("absent");
    let mut value: i32 = 0;
    let mut error: FonError = new_error();
    assert_eq!(fon_collection_get_int(c, k, kl, &mut value, &mut error), FON_ERROR_NOT_FOUND);
    assert!(message_of(&error).contains("'absent' not found"));

    let (k, kl) = key("text");
    assert_eq!(fon_collection_get_int(c, k, kl, &mut value, &mut error), FON_ERROR_TYPE_MISMATCH);
    assert!(message_of(&error).contains("string, not int"));
    fon_collection_free(c);
}


#[test]
fn numeric_arrays_round_trip_and_partial_buffers_fail() {
    let c: *mut c_void = fon_collection_create();
    let ints: [i32; 3] = [i32::MIN, 0, i32::MAX];
    let (k, kl) = key("ints");
    assert_eq!(fon_collection_put_int_array(c, k, kl, ints.as_ptr(), 3, FON_PUT_ADD, &mut new_error()), FON_OK);
    let doubles: [f64; 2] = [f64::INFINITY, -0.5];
    let (k, kl) = key("doubles");
    assert_eq!(fon_collection_put_double_array(c, k, kl, doubles.as_ptr(), 2, FON_PUT_ADD, &mut new_error()), FON_OK);
    let bytes: [u8; 2] = [0, 255];
    let (k, kl) = key("bytes");
    assert_eq!(fon_collection_put_byte_array(c, k, kl, bytes.as_ptr(), 2, FON_PUT_ADD, &mut new_error()), FON_OK);

    let (k, kl) = key("ints");
    let mut needed: i64 = 0;
    assert_eq!(fon_collection_get_int_array(c, k, kl, ptr::null_mut(), 0, &mut needed, &mut new_error()), FON_OK);
    assert_eq!(needed, 3);
    let mut partial: [i32; 2] = [7, 7];
    let mut error: FonError = new_error();
    assert_eq!(
        fon_collection_get_int_array(c, k, kl, partial.as_mut_ptr(), 2, &mut needed, &mut error),
        FON_ERROR_BUFFER_TOO_SMALL
    );
    assert_eq!(partial, [7, 7]);
    let mut out: [i32; 3] = [0; 3];
    assert_eq!(fon_collection_get_int_array(c, k, kl, out.as_mut_ptr(), 3, &mut needed, &mut error), FON_OK);
    assert_eq!(out, ints);

    let (k, kl) = key("doubles");
    let mut back: [f64; 2] = [0.0; 2];
    assert_eq!(fon_collection_get_double_array(c, k, kl, back.as_mut_ptr(), 2, &mut needed, &mut error), FON_OK);
    assert_eq!(back, doubles);

    let (k, kl) = key("bytes");
    let mut back_bytes: [u8; 2] = [0; 2];
    assert_eq!(fon_collection_get_byte_array(c, k, kl, back_bytes.as_mut_ptr(), 2, &mut needed, &mut error), FON_OK);
    assert_eq!(back_bytes, bytes);

    let (k, kl) = key("ints");
    assert_eq!(fon_collection_get_double_array(c, k, kl, back.as_mut_ptr(), 2, &mut needed, &mut error), FON_ERROR_TYPE_MISMATCH);
    fon_collection_free(c);
}


#[test]
fn string_arrays_use_the_multi_string_pattern() {
    let c: *mut c_void = fon_collection_create();
    let middle: String = "b".repeat(8192);
    let items: Vec<&str> = vec!["x", middle.as_str(), "", "ж😀\0"];
    let lengths: Vec<i64> = items.iter().map(|item| to_i64(item.len())).collect();
    let payload: Vec<u8> = items.iter().flat_map(|item| item.as_bytes().to_vec()).collect();
    let (k, kl) = key("list");
    assert_eq!(
        fon_collection_put_string_array(c, k, kl, lengths.as_ptr(), payload.as_ptr(), 4, FON_PUT_ADD, &mut new_error()),
        FON_OK
    );

    let mut count: i64 = 0;
    let mut total: i64 = 0;
    let mut error: FonError = new_error();
    assert_eq!(
        fon_collection_get_string_array(c, k, kl, ptr::null_mut(), 0, ptr::null_mut(), 0, &mut count, &mut total, &mut error),
        FON_OK
    );
    assert_eq!(count, 4);
    assert_eq!(total, to_i64(payload.len()));

    let mut out_lengths: Vec<i64> = vec![-1; 4];
    let mut out_bytes: Vec<u8> = vec![0; payload.len()];
    let code: i32 = fon_collection_get_string_array(
        c,
        k,
        kl,
        out_lengths.as_mut_ptr(),
        4,
        out_bytes.as_mut_ptr(),
        to_i64(payload.len()) - 1,
        &mut count,
        &mut total,
        &mut error,
    );
    assert_eq!(code, FON_ERROR_BUFFER_TOO_SMALL);
    assert_eq!(out_lengths, vec![-1; 4]);
    assert_eq!(total, to_i64(payload.len()));

    let code: i32 = fon_collection_get_string_array(
        c,
        k,
        kl,
        out_lengths.as_mut_ptr(),
        4,
        out_bytes.as_mut_ptr(),
        to_i64(payload.len()),
        &mut count,
        &mut total,
        &mut error,
    );
    assert_eq!(code, FON_OK);
    assert_eq!(out_lengths, lengths);
    assert_eq!(out_bytes, payload);

    let (k, kl) = key("list");
    let mut bool_count: i64 = 0;
    assert_eq!(
        fon_collection_get_bool_array(c, k, kl, ptr::null_mut(), 0, &mut bool_count, &mut error),
        FON_ERROR_TYPE_MISMATCH
    );
    fon_collection_free(c);
}


#[test]
fn string_array_rejects_invalid_utf8_and_bad_lengths() {
    let c: *mut c_void = fon_collection_create();
    let (k, kl) = key("list");
    let bad_bytes: [u8; 1] = [0xFF];
    let lengths: [i64; 1] = [1];
    let mut error: FonError = new_error();
    assert_eq!(
        fon_collection_put_string_array(c, k, kl, lengths.as_ptr(), bad_bytes.as_ptr(), 1, FON_PUT_ADD, &mut error),
        FON_ERROR_INVALID_ARGUMENT
    );
    let negative: [i64; 1] = [-1];
    assert_eq!(
        fon_collection_put_string_array(c, k, kl, negative.as_ptr(), bad_bytes.as_ptr(), 1, FON_PUT_ADD, &mut error),
        FON_ERROR_INVALID_ARGUMENT
    );
    let (k, kl) = key("list");
    assert_eq!(
        fon_collection_put_string_array(c, k, kl, ptr::null(), ptr::null(), 0, FON_PUT_ADD, &mut error),
        FON_OK
    );
    assert_eq!(read_keys(c).0, vec!["list".to_string()]);
    fon_collection_free(c);
}


#[test]
fn bool_arrays_round_trip() {
    let c: *mut c_void = fon_collection_create();
    let flags: [u8; 3] = [0, 1, 9];
    let (k, kl) = key("flags");
    assert_eq!(fon_collection_put_bool_array(c, k, kl, flags.as_ptr(), 3, FON_PUT_ADD, &mut new_error()), FON_OK);
    let mut out: [u8; 3] = [0; 3];
    let mut needed: i64 = 0;
    assert_eq!(fon_collection_get_bool_array(c, k, kl, out.as_mut_ptr(), 3, &mut needed, &mut new_error()), FON_OK);
    assert_eq!(out, [0, 1, 1]);
    assert_eq!(needed, 3);
    fon_collection_free(c);
}


#[test]
fn raw_values_round_trip_including_empty() {
    let c: *mut c_void = fon_collection_create();
    let blob: Vec<u8> = (0u8..=255).collect();
    let (k, kl) = key("blob");
    assert_eq!(fon_collection_put_raw(c, k, kl, blob.as_ptr(), to_i64(blob.len()), FON_PUT_ADD, &mut new_error()), FON_OK);
    let (k, kl) = key("empty");
    assert_eq!(fon_collection_put_raw(c, k, kl, ptr::null(), 0, FON_PUT_ADD, &mut new_error()), FON_OK);

    let (k, kl) = key("blob");
    let mut needed: i64 = 0;
    let mut out: Vec<u8> = vec![0; blob.len()];
    assert_eq!(fon_collection_get_raw(c, k, kl, out.as_mut_ptr(), to_i64(out.len()), &mut needed, &mut new_error()), FON_OK);
    assert_eq!(out, blob);

    let (k, kl) = key("empty");
    assert_eq!(fon_collection_get_raw(c, k, kl, ptr::null_mut(), 0, &mut needed, &mut new_error()), FON_OK);
    assert_eq!(needed, 0);
    fon_collection_free(c);
}


#[test]
fn keys_kinds_order_and_removal() {
    let c: *mut c_void = fon_collection_create();
    assert_eq!(put_int(c, "first", 1, FON_PUT_ADD), FON_OK);
    assert_eq!(put_string(c, "second", "two", FON_PUT_ADD), FON_OK);
    let (k, kl) = key("third");
    assert_eq!(fon_collection_put_int_array(c, k, kl, [3, 4].as_ptr(), 2, FON_PUT_ADD, &mut new_error()), FON_OK);

    let (keys, kinds) = read_keys(c);
    assert_eq!(keys, vec!["first", "second", "third"]);
    assert_eq!(kinds, vec![i32::from(TYPE_INT), i32::from(TYPE_STRING), i32::from(TYPE_INT) | FON_KIND_ARRAY]);
    assert_eq!(fon_collection_size(c), 3);

    let (k, kl) = key("second");
    assert_eq!(fon_collection_remove(c, k, kl), 1);
    assert_eq!(fon_collection_remove(c, k, kl), 0);
    assert_eq!(fon_collection_remove(ptr::null_mut(), k, kl), 0);
    assert_eq!(read_keys(c).0, vec!["first", "third"]);
    fon_collection_free(c);
}


#[test]
fn clone_is_a_deep_copy() {
    let original: *mut c_void = fon_collection_create();
    assert_eq!(put_int(original, "n", 1, FON_PUT_ADD), FON_OK);
    let child: *mut c_void = fon_collection_create();
    assert_eq!(put_int(child, "inner", 10, FON_PUT_ADD), FON_OK);
    assert_eq!(fon_collection_put_collection(original, b"c".as_ptr(), 1, child, FON_PUT_ADD, &mut new_error()), FON_OK);

    let copy: *mut c_void = fon_collection_clone(original, &mut new_error());
    assert!(!copy.is_null());
    assert_eq!(put_int(copy, "n", 2, FON_PUT_SET), FON_OK);
    let borrowed: *mut c_void = fon_collection_get_collection(copy, b"c".as_ptr(), 1, &mut new_error());
    assert_eq!(put_int(borrowed, "inner", 99, FON_PUT_SET), FON_OK);

    assert_eq!(read_int(original, "n"), Ok(1));
    let original_child: *mut c_void = fon_collection_get_collection(original, b"c".as_ptr(), 1, &mut new_error());
    assert_eq!(read_int(original_child, "inner"), Ok(10));

    fon_collection_free(copy);
    fon_collection_free(original);
}


#[test]
fn nested_put_transfers_ownership_and_borrowed_get_reads_through() {
    let parent: *mut c_void = fon_collection_create();
    let child: *mut c_void = fon_collection_create();
    assert_eq!(put_int(child, "x", 5, FON_PUT_ADD), FON_OK);
    let (k, kl) = key("child");
    assert_eq!(fon_collection_put_collection(parent, k, kl, child, FON_PUT_ADD, &mut new_error()), FON_OK);

    let borrowed: *mut c_void = fon_collection_get_collection(parent, k, kl, &mut new_error());
    assert!(!borrowed.is_null());
    assert_eq!(read_int(borrowed, "x"), Ok(5));
    fon_collection_free(parent);
}


#[test]
fn failed_nested_put_keeps_the_child_owned() {
    let parent: *mut c_void = fon_collection_create();
    assert_eq!(put_int(parent, "taken", 1, FON_PUT_ADD), FON_OK);
    let child: *mut c_void = fon_collection_create();
    assert_eq!(put_int(child, "x", 5, FON_PUT_ADD), FON_OK);
    let (k, kl) = key("taken");
    let mut error: FonError = new_error();
    assert_eq!(fon_collection_put_collection(parent, k, kl, child, FON_PUT_ADD, &mut error), FON_ERROR_ALREADY_EXISTS);
    assert_eq!(fon_collection_size(child), 1);
    assert_eq!(read_int(child, "x"), Ok(5));
    fon_collection_free(child);
    fon_collection_free(parent);
}


#[test]
fn self_null_and_duplicate_children_are_rejected() {
    let parent: *mut c_void = fon_collection_create();
    let mut error: FonError = new_error();
    let (k, kl) = key("self");
    assert_eq!(fon_collection_put_collection(parent, k, kl, parent, FON_PUT_ADD, &mut error), FON_ERROR_INVALID_ARGUMENT);
    assert_eq!(fon_collection_put_collection(parent, k, kl, ptr::null_mut(), FON_PUT_ADD, &mut error), FON_ERROR_INVALID_ARGUMENT);
    assert_eq!(fon_collection_size(parent), 0);

    let child: *mut c_void = fon_collection_create();
    let children: [*mut c_void; 2] = [child, child];
    let (k, kl) = key("list");
    assert_eq!(
        fon_collection_put_collection_array(parent, k, kl, children.as_ptr(), 2, FON_PUT_ADD, &mut error),
        FON_ERROR_INVALID_ARGUMENT
    );
    assert!(message_of(&error).contains("twice"));
    assert_eq!(fon_collection_size(parent), 0);
    fon_collection_free(child);
    fon_collection_free(parent);
}


#[test]
fn collection_arrays_transfer_all_children_and_expose_borrowed_handles() {
    let parent: *mut c_void = fon_collection_create();
    let first: *mut c_void = fon_collection_create();
    let second: *mut c_void = fon_collection_create();
    assert_eq!(put_int(first, "n", 1, FON_PUT_ADD), FON_OK);
    assert_eq!(put_int(second, "n", 2, FON_PUT_ADD), FON_OK);
    let children: [*mut c_void; 2] = [first, second];
    let (k, kl) = key("rows");
    assert_eq!(
        fon_collection_put_collection_array(parent, k, kl, children.as_ptr(), 2, FON_PUT_ADD, &mut new_error()),
        FON_OK
    );

    let mut needed: i64 = 0;
    assert_eq!(
        fon_collection_get_collection_array(parent, k, kl, ptr::null_mut(), 0, &mut needed, &mut new_error()),
        FON_OK
    );
    assert_eq!(needed, 2);
    let mut handles: [*mut c_void; 2] = [ptr::null_mut(); 2];
    assert_eq!(
        fon_collection_get_collection_array(parent, k, kl, handles.as_mut_ptr(), 2, &mut needed, &mut new_error()),
        FON_OK
    );
    assert_eq!(read_int(handles[0], "n"), Ok(1));
    assert_eq!(read_int(handles[1], "n"), Ok(2));

    let mut error: FonError = new_error();
    assert_eq!(
        fon_collection_get_collection_array(parent, k, kl, handles.as_mut_ptr(), 1, &mut needed, &mut error),
        FON_ERROR_BUFFER_TOO_SMALL
    );
    assert_eq!(needed, 2);

    let (k, kl) = key("rows");
    let single: *mut c_void = fon_collection_get_collection(parent, k, kl, &mut error);
    assert!(single.is_null());
    assert_eq!(error.code, FON_ERROR_TYPE_MISMATCH);
    fon_collection_free(parent);
}


#[test]
fn dump_ids_are_sorted_and_removal_is_reported() {
    let dump: *mut c_void = fon_dump_create();
    for id in [5u64, 1, 9] {
        let record: *mut c_void = fon_collection_create();
        assert_eq!(put_int(record, "id", to_i64(id as usize) as i32, FON_PUT_ADD), FON_OK);
        assert_eq!(fon_dump_put(dump, id, record, FON_PUT_ADD, &mut new_error()), FON_OK);
    }
    assert_eq!(dump_ids(dump), vec![1, 5, 9]);
    assert_eq!(fon_dump_size(dump), 3);

    let clash: *mut c_void = fon_collection_create();
    let mut error: FonError = new_error();
    assert_eq!(fon_dump_put(dump, 5, clash, FON_PUT_ADD, &mut error), FON_ERROR_ALREADY_EXISTS);
    assert!(message_of(&error).contains("id 5 already exists"));
    assert_eq!(fon_collection_size(clash), 0);
    fon_collection_free(clash);

    let absent: *mut c_void = fon_collection_create();
    assert_eq!(fon_dump_put(dump, 42, absent, FON_PUT_SET, &mut error), FON_ERROR_NOT_FOUND);
    fon_collection_free(absent);

    assert_eq!(fon_dump_remove(dump, 1), 1);
    assert_eq!(fon_dump_remove(dump, 1), 0);
    assert_eq!(dump_ids(dump), vec![5, 9]);

    let ids: [u64; 4] = [5, 5, 42, 9];
    assert_eq!(fon_dump_remove_many(dump, ids.as_ptr(), 4), 2);
    assert_eq!(fon_dump_size(dump), 0);
    assert!(dump_ids(dump).is_empty());
    fon_dump_free(dump);
}


#[test]
fn dump_get_set_and_generations() {
    let dump: *mut c_void = fon_dump_create();
    let record: *mut c_void = fon_collection_create();
    assert_eq!(put_int(record, "w", 3, FON_PUT_ADD), FON_OK);
    assert_eq!(fon_dump_put(dump, 3, record, FON_PUT_ADD, &mut new_error()), FON_OK);

    let view: *mut c_void = fon_dump_get(dump, 3);
    assert_eq!(read_int(view, "w"), Ok(3));
    assert!(fon_dump_get(dump, 4).is_null());

    let mut record_gen: u32 = 0;
    let mut tree_gen: u32 = 0;
    assert_eq!(fon_dump_gens(dump, 3, &mut record_gen, &mut tree_gen), 1);
    assert_eq!(fon_dump_gens(dump, 4, &mut record_gen, &mut tree_gen), 0);

    assert_eq!(fon_dump_touch(dump, 3), 1);
    let mut touched_record: u32 = 0;
    let mut touched_tree: u32 = 0;
    assert_eq!(fon_dump_gens(dump, 3, &mut touched_record, &mut touched_tree), 1);
    assert_eq!(touched_record, record_gen);
    assert_ne!(touched_tree, tree_gen);

    let replacement: *mut c_void = fon_collection_create();
    assert_eq!(put_int(replacement, "w", 4, FON_PUT_ADD), FON_OK);
    assert_eq!(fon_dump_put(dump, 3, replacement, FON_PUT_SET, &mut new_error()), FON_OK);
    assert_eq!(fon_dump_gens(dump, 3, &mut touched_record, &mut touched_tree), 1);
    assert_ne!(touched_record, record_gen);
    assert_eq!(read_int(fon_dump_get(dump, 3), "w"), Ok(4));

    assert_eq!(fon_dump_remove(dump, 3), 1);
    assert_eq!(fon_dump_gens(dump, 3, &mut touched_record, &mut touched_tree), 0);
    assert_eq!(fon_dump_touch(dump, 3), 0);
    fon_dump_free(dump);
}


#[test]
fn dump_enumeration_scales_linearly() {
    let dump: *mut c_void = fon_dump_create();
    let count: u64 = 10_000;
    for id in (0..count).rev() {
        let record: *mut c_void = fon_collection_create();
        assert_eq!(fon_dump_put(dump, id, record, FON_PUT_ADD, &mut new_error()), FON_OK);
    }
    let ids: Vec<u64> = dump_ids(dump);
    assert_eq!(ids.len(), count as usize);
    assert!(ids.windows(2).all(|pair| pair[0] < pair[1]));
    fon_dump_free(dump);
}


#[test]
fn serialize_round_trips_through_owned_buffers() {
    let dump: *mut c_void = fon_dump_create();
    for id in 0u64..3 {
        let record: *mut c_void = fon_collection_create();
        assert_eq!(put_string(record, "name", &format!("row {id}\0end"), FON_PUT_ADD), FON_OK);
        assert_eq!(put_int(record, "n", to_i64(id as usize) as i32, FON_PUT_ADD), FON_OK);
        assert_eq!(fon_dump_put(dump, id, record, FON_PUT_ADD, &mut new_error()), FON_OK);
    }

    let mut out: *mut u8 = ptr::null_mut();
    let mut out_len: i64 = 0;
    assert_eq!(fon_serialize_dump(dump, 0, &mut out, &mut out_len, &mut new_error()), FON_OK);
    assert!(!out.is_null());
    let text: Vec<u8> = unsafe { std::slice::from_raw_parts(out, out_len as usize).to_vec() };
    fon_buffer_free(out, out_len);

    let restored: *mut c_void = fon_deserialize_dump(text.as_ptr(), to_i64(text.len()), 0, &mut new_error());
    assert!(!restored.is_null());
    assert_eq!(dump_ids(restored), vec![0, 1, 2]);
    assert_eq!(read_string(fon_dump_get(restored, 2), "name"), Ok("row 2\0end".to_string()));

    let mut again: *mut u8 = ptr::null_mut();
    let mut again_len: i64 = 0;
    assert_eq!(fon_serialize_dump(restored, 1, &mut again, &mut again_len, &mut new_error()), FON_OK);
    let again_bytes: Vec<u8> = unsafe { std::slice::from_raw_parts(again, again_len as usize).to_vec() };
    fon_buffer_free(again, again_len);
    assert_eq!(again_bytes, text);

    fon_dump_free(restored);
    fon_dump_free(dump);
}


#[test]
fn empty_output_is_null_and_free_is_a_no_op() {
    let dump: *mut c_void = fon_dump_create();
    let mut out: *mut u8 = ptr::null_mut();
    let mut out_len: i64 = -1;
    assert_eq!(fon_serialize_dump(dump, 0, &mut out, &mut out_len, &mut new_error()), FON_OK);
    assert!(out.is_null());
    assert_eq!(out_len, 0);
    fon_buffer_free(ptr::null_mut(), 0);
    fon_buffer_free(out, out_len);
    fon_dump_free(dump);
}


#[test]
fn serialize_collection_round_trips() {
    let c: *mut c_void = fon_collection_create();
    assert_eq!(put_string(c, "s", "a,b}{", FON_PUT_ADD), FON_OK);
    let mut out: *mut u8 = ptr::null_mut();
    let mut out_len: i64 = 0;
    assert_eq!(fon_serialize_collection(c, &mut out, &mut out_len, &mut new_error()), FON_OK);
    let text: Vec<u8> = unsafe { std::slice::from_raw_parts(out, out_len as usize).to_vec() };
    fon_buffer_free(out, out_len);
    fon_collection_free(c);

    let restored: *mut c_void = fon_deserialize_collection(text.as_ptr(), to_i64(text.len()), &mut new_error());
    assert!(!restored.is_null());
    assert_eq!(read_string(restored, "s"), Ok("a,b}{".to_string()));
    fon_collection_free(restored);
}


#[test]
fn files_round_trip_and_missing_files_are_reported() {
    let dump: *mut c_void = fon_dump_create();
    let record: *mut c_void = fon_collection_create();
    assert_eq!(put_string(record, "s", "file\\", FON_PUT_ADD), FON_OK);
    assert_eq!(fon_dump_put(dump, 0, record, FON_PUT_ADD, &mut new_error()), FON_OK);

    let path = std::env::temp_dir().join(format!("fon_native_shim_{}.fon", std::process::id()));
    let path_text: String = path.to_string_lossy().into_owned();
    let mut error: FonError = new_error();
    assert_eq!(
        fon_serialize_to_file(dump, path_text.as_ptr(), to_i64(path_text.len()), 2, &mut error),
        FON_OK
    );
    let loaded: *mut c_void = fon_deserialize_from_file(path_text.as_ptr(), to_i64(path_text.len()), 1, &mut error);
    assert!(!loaded.is_null());
    assert_eq!(read_string(fon_dump_get(loaded, 0), "s"), Ok("file\\".to_string()));
    fon_dump_free(loaded);
    fon_dump_free(dump);
    let _ = fs::remove_file(&path);

    let missing = std::env::temp_dir().join(format!("fon_native_missing_{}.fon", std::process::id()));
    let missing_text: String = missing.to_string_lossy().into_owned();
    let mut error: FonError = new_error();
    let absent: *mut c_void = fon_deserialize_from_file(missing_text.as_ptr(), to_i64(missing_text.len()), 0, &mut error);
    assert!(absent.is_null());
    assert_eq!(error.code, FON_ERROR_FILE_NOT_FOUND);
}


#[test]
fn deserialize_reports_parse_errors() {
    let text: &[u8] = b"a=i:not-a-number\n";
    let mut error: FonError = new_error();
    let dump: *mut c_void = fon_deserialize_dump(text.as_ptr(), to_i64(text.len()), 0, &mut error);
    assert!(dump.is_null());
    assert_eq!(error.code, FON_ERROR_PARSE_FAILED);
    let line: *mut c_void = fon_deserialize_collection(ptr::null(), 3, &mut error);
    assert!(line.is_null());
    assert_eq!(error.code, FON_ERROR_INVALID_ARGUMENT);
}


#[test]
fn null_handles_fail_cleanly_without_panicking() {
    let mut error: FonError = new_error();
    let (k, kl) = key("k");
    assert_eq!(fon_collection_put_int(ptr::null_mut(), k, kl, 1, FON_PUT_ADD, &mut error), FON_ERROR_INVALID_ARGUMENT);
    assert_eq!(fon_collection_size(ptr::null_mut()), 0);
    assert_eq!(fon_collection_kind_of(ptr::null_mut(), k, kl), -1);
    assert_eq!(fon_dump_size(ptr::null_mut()), 0);
    assert!(fon_dump_get(ptr::null_mut(), 0).is_null());
    assert_eq!(fon_dump_put(ptr::null_mut(), 0, ptr::null_mut(), FON_PUT_ADD, &mut error), FON_ERROR_INVALID_ARGUMENT);
    assert_eq!(fon_dump_remove(ptr::null_mut(), 0), 0);
    assert!(fon_collection_clone(ptr::null_mut(), &mut error).is_null());
    assert_eq!(error.code, FON_ERROR_INVALID_ARGUMENT);
    fon_collection_free(ptr::null_mut());
    fon_dump_free(ptr::null_mut());
}


#[test]
fn configuration_and_version_setters_accept_any_value() {
    fon_set_raw_unpack(0);
    fon_set_raw_unpack(1);
    fon_set_raw_unpack(0);
    fon_set_max_depth(64);
    let options = crate::config::deserialize_options();
    assert_eq!(options.max_depth, 64);
    assert!(!options.unpack_raw);
}
