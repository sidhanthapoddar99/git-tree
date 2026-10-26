//! The engine's error type.
//!
//! The extension treats both kinds the same way, by running the `git` CLI read instead. They differ in
//! what they mean: `Unsupported` is an expected limit of the engine, and `Failed` is a read that went
//! wrong. The extension logs the second kind as an error.

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// The engine can't answer with certainty, so the caller must run the `git` CLI read instead.
    /// A guess that looks right is worse than a slower right answer.
    Unsupported(String),
    /// The read failed: the repository couldn't be opened, or an object couldn't be read.
    Failed(String),
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    pub fn unsupported(message: impl Into<String>) -> Error {
        Error::Unsupported(message.into())
    }

    pub fn failed(message: impl Into<String>) -> Error {
        Error::Failed(message.into())
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Unsupported(message) => write!(f, "Unsupported: {message}"),
            Error::Failed(message) => write!(f, "Failed: {message}"),
        }
    }
}

impl std::error::Error for Error {}

/// Turn any error from gix into [`Error::Failed`], with what the engine was doing.
pub(crate) trait Context<T> {
    fn context(self, doing: &str) -> Result<T>;
}

impl<T, E: fmt::Display> Context<T> for std::result::Result<T, E> {
    fn context(self, doing: &str) -> Result<T> {
        self.map_err(|e| Error::failed(format!("{doing}: {e}")))
    }
}

/// Return early with [`Error::Unsupported`].
macro_rules! unsupported {
    ($($arg:tt)*) => {
        return Err($crate::error::Error::Unsupported(format!($($arg)*)))
    };
}
pub(crate) use unsupported;
