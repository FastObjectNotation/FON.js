//! FON native library: a C ABI shim over the `fon` crate.
//!
//! The exported surface is defined by `include/fon.h`, the authoritative contract.
//! Modules, by concern:
//!
//! - `error`: result codes, put modes, the `FonError` struct, and the shared helpers
//!   (ptr+len arguments, the size-query and multi-string writers, error reporting).
//! - `config`: version reporting and the global deserialization settings.
//! - `collection`: collection lifecycle, clone, keys, kinds, removal, put/lookup helpers.
//! - `scalar`, `array`, `nesting`: typed values, arrays, and nested collections.
//! - `dump`: dump lifecycle, ids, borrowed records, put/remove, generations.
//! - `serialize`, `deserialize`: text and buffer I/O.
//!
//! Every `#[no_mangle] extern "C"` function keeps the symbol name declared in `fon.h`.

mod array;
mod collection;
mod config;
mod deserialize;
mod dump;
mod error;
mod nesting;
mod scalar;
mod serialize;

#[cfg(test)]
mod tests;
