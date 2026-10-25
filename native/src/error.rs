//! Result codes, put modes, the FFI error struct, and the helpers every other
//! module shares: ptr+len argument readers, the size-query and multi-string
//! writers, and the reporting used by the exported functions.

use std::ptr;
use std::slice;
use std::str;

use fon::FonError as CoreError;


pub const FON_OK: i32 = 0;
pub const FON_ERROR_FILE_NOT_FOUND: i32 = 1;
pub const FON_ERROR_PARSE_FAILED: i32 = 2;
pub const FON_ERROR_WRITE_FAILED: i32 = 3;
pub const FON_ERROR_INVALID_ARGUMENT: i32 = 4;
pub const FON_ERROR_BUFFER_TOO_SMALL: i32 = 5;
pub const FON_ERROR_NOT_FOUND: i32 = 6;
pub const FON_ERROR_TYPE_MISMATCH: i32 = 7;
pub const FON_ERROR_ALREADY_EXISTS: i32 = 8;
#[allow(dead_code)]
pub const FON_ERROR_STALE_VIEW: i32 = 9;


pub const FON_PUT_ADD: i32 = 0;
pub const FON_PUT_SET: i32 = 1;
pub const FON_PUT_UPSERT: i32 = 2;


#[repr(C)]
pub struct FonError {
    pub code: i32,
    pub message: [u8; 256],
}


/// A failure: the result code plus the message written into `FonError`.
#[derive(Debug)]
pub struct Failure {
    pub code: i32,
    pub message: String,
}


impl Failure {
    pub fn new(code: i32, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}


impl From<CoreError> for Failure {
    fn from(error: CoreError) -> Self {
        let code: i32 = match &error {
            CoreError::Parse(_) => FON_ERROR_PARSE_FAILED,
            CoreError::Write(_) => FON_ERROR_WRITE_FAILED,
            CoreError::InvalidArgument(_) => FON_ERROR_INVALID_ARGUMENT,
        };
        Failure::new(code, error.to_string())
    }
}


pub fn invalid(message: impl Into<String>) -> Failure {
    Failure::new(FON_ERROR_INVALID_ARGUMENT, message)
}


pub fn to_i64(count: usize) -> i64 {
    i64::try_from(count).unwrap_or(i64::MAX)
}


/// Writes `code` and `message` into `error`. The message is NUL-terminated and
/// truncated to fit, on a character boundary.
pub(crate) unsafe fn set_error(error: *mut FonError, code: i32, message: &str) {
    if error.is_null() {
        return;
    }
    let mut end: usize = message.len().min(255);
    while !message.is_char_boundary(end) {
        end -= 1;
    }
    let target: &mut FonError = &mut *error;
    target.code = code;
    target.message = [0; 256];
    target.message[..end].copy_from_slice(&message.as_bytes()[..end]);
}


pub(crate) unsafe fn report(error: *mut FonError, failure: &Failure) -> i32 {
    set_error(error, failure.code, &failure.message);
    failure.code
}


/// Maps a unit result onto the exported `int32_t` return value.
pub(crate) unsafe fn finish(error: *mut FonError, result: Result<(), Failure>) -> i32 {
    match result {
        Ok(()) => FON_OK,
        Err(failure) => report(error, &failure),
    }
}


/// Maps a handle result onto the exported handle return value (NULL on failure).
pub(crate) unsafe fn handle_or_report<T>(
    error: *mut FonError,
    result: Result<*mut T, Failure>,
) -> *mut T {
    match result {
        Ok(handle) => handle,
        Err(failure) => {
            report(error, &failure);
            ptr::null_mut()
        }
    }
}


/// Reads a `(data, count)` argument as a slice. A zero count accepts a NULL pointer.
pub(crate) unsafe fn slice_arg<'a, T>(data: *const T, count: i64) -> Result<&'a [T], Failure> {
    if count < 0 {
        return Err(invalid(format!("negative length {count}")));
    }
    if count == 0 {
        return Ok(&[]);
    }
    if data.is_null() {
        return Err(invalid("null pointer with a non-zero length"));
    }
    Ok(slice::from_raw_parts(data, count as usize))
}


/// Reads a `(ptr, len)` UTF-8 string argument. Embedded U+0000 is kept.
pub(crate) unsafe fn str_arg<'a>(data: *const u8, len: i64) -> Result<&'a str, Failure> {
    let bytes: &'a [u8] = slice_arg(data, len)?;
    str::from_utf8(bytes).map_err(|_| invalid("string argument is not valid UTF-8"))
}


/// Writes one value into a caller out-parameter.
pub(crate) unsafe fn write_out<T>(out: *mut T, value: T) -> Result<(), Failure> {
    if out.is_null() {
        return Err(invalid("out is null"));
    }
    ptr::write(out, value);
    Ok(())
}


/// Size-query pattern. Always reports the exact element count in `actual`; writes
/// the elements only when `buffer` is non-NULL and `capacity` holds all of them.
pub(crate) unsafe fn write_sized<T: Copy>(
    items: &[T],
    buffer: *mut T,
    capacity: i64,
    actual: *mut i64,
) -> Result<(), Failure> {
    if actual.is_null() {
        return Err(invalid("actual is null"));
    }
    let required: i64 = to_i64(items.len());
    *actual = required;
    if buffer.is_null() {
        return Ok(());
    }
    if capacity < 0 {
        return Err(invalid(format!("negative buffer capacity {capacity}")));
    }
    if capacity < required {
        return Err(Failure::new(
            FON_ERROR_BUFFER_TOO_SMALL,
            format!("buffer holds {capacity} elements, {required} required"),
        ));
    }
    slice::from_raw_parts_mut(buffer, items.len()).copy_from_slice(items);
    Ok(())
}


/// Multi-string pattern. `count` and `total_bytes` are written on every path that
/// is not an argument error. Returns `Ok(true)` when the payload was written and
/// `Ok(false)` for a size query.
pub(crate) unsafe fn write_multi(
    items: &[&[u8]],
    lengths: *mut i64,
    lengths_capacity: i64,
    bytes: *mut u8,
    bytes_capacity: i64,
    count: *mut i64,
    total_bytes: *mut i64,
) -> Result<bool, Failure> {
    if count.is_null() || total_bytes.is_null() {
        return Err(invalid("count and total_bytes must not be null"));
    }
    let item_count: i64 = to_i64(items.len());
    let total: usize = items.iter().map(|item| item.len()).sum();
    *count = item_count;
    *total_bytes = to_i64(total);
    if lengths.is_null() || (bytes.is_null() && total > 0) {
        return Ok(false);
    }
    if lengths_capacity < 0 || bytes_capacity < 0 {
        return Err(invalid(format!(
            "negative buffer capacity (lengths {lengths_capacity}, bytes {bytes_capacity})"
        )));
    }
    if lengths_capacity < item_count {
        return Err(Failure::new(
            FON_ERROR_BUFFER_TOO_SMALL,
            format!("lengths hold {lengths_capacity} items, {item_count} required"),
        ));
    }
    if bytes_capacity < to_i64(total) {
        return Err(Failure::new(
            FON_ERROR_BUFFER_TOO_SMALL,
            format!("bytes hold {bytes_capacity} bytes, {total} required"),
        ));
    }
    let lens: &mut [i64] = slice::from_raw_parts_mut(lengths, items.len());
    for (slot, item) in lens.iter_mut().zip(items) {
        *slot = to_i64(item.len());
    }
    if total > 0 {
        let mut rest: &mut [u8] = slice::from_raw_parts_mut(bytes, total);
        for item in items {
            let Some((head, tail)) = rest.split_at_mut_checked(item.len()) else {
                return Err(invalid("internal: item lengths exceed the payload"));
            };
            head.copy_from_slice(item);
            rest = tail;
        }
    }
    Ok(true)
}


/// Checks a put mode against the current existence of the target.
pub(crate) fn check_put(mode: i32, exists: bool, what: &str) -> Result<(), Failure> {
    match mode {
        FON_PUT_ADD if exists => Err(Failure::new(
            FON_ERROR_ALREADY_EXISTS,
            format!("{what} already exists"),
        )),
        FON_PUT_SET if !exists => Err(Failure::new(
            FON_ERROR_NOT_FOUND,
            format!("{what} not found"),
        )),
        FON_PUT_ADD | FON_PUT_SET | FON_PUT_UPSERT => Ok(()),
        _ => Err(invalid(format!("invalid put mode {mode}"))),
    }
}
