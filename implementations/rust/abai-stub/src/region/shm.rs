//! The region as a mapped shared segment (contract section 6.3): a file
//! both processes map, so cells, events and replies cross with no system
//! call.
//!
//! The segment is a file in the run directory, named for the program's
//! pid, so a harness finds it from the program's descriptor and a dead
//! program's segment is removed with its descriptor.

use std::fs::{File, OpenOptions};
use std::io;
use std::os::fd::AsRawFd;
use std::path::Path;
use std::sync::atomic::AtomicU64;

/// A file mapped shared and writable, seen as words.
pub(crate) struct Mapping {
    start: *mut AtomicU64,
    words: usize,
}

// SAFETY: the mapping is plain memory that lives until the value is
// dropped, and every access to it goes through an atomic.
unsafe impl Send for Mapping {}
// SAFETY: as above; shared access is what atomics are for.
unsafe impl Sync for Mapping {}

impl Mapping {
    fn map(file: &File, words: usize) -> io::Result<Self> {
        let bytes = words
            .checked_mul(8)
            .filter(|bytes| *bytes > 0)
            .ok_or_else(|| io::Error::other("a region has at least one word"))?;
        // SAFETY: a fresh shared mapping of `bytes` bytes of an open
        // file; the kernel picks the address, and the result is checked.
        let start = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                bytes,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_SHARED,
                file.as_raw_fd(),
                0,
            )
        };
        if start == libc::MAP_FAILED {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            start: start.cast(),
            words,
        })
    }

    /// Create the segment file, sized for `words` words of zeros, and map
    /// it. The file is the owner's alone (mode 0600).
    pub(crate) fn create(path: &Path, words: usize) -> io::Result<Self> {
        // a file left at this path by a program that crashed may still be
        // mapped by its harness: it is unlinked, never reused
        let _ = std::fs::remove_file(path);
        let mut options = OpenOptions::new();
        options.read(true).write(true).create_new(true);
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let file = options.open(path)?;
        file.set_len(words as u64 * 8)?;
        Self::map(&file, words)
    }

    /// Map a segment another process created. Its length says how many
    /// words it has.
    pub(crate) fn open(path: &Path) -> io::Result<Self> {
        let file = OpenOptions::new().read(true).write(true).open(path)?;
        let bytes = file.metadata()?.len();
        if bytes == 0 || bytes % 8 != 0 {
            return Err(io::Error::other(format!(
                "{} is not a region: {bytes} bytes",
                path.display()
            )));
        }
        Self::map(&file, (bytes / 8) as usize)
    }

    pub(crate) fn words(&self) -> &[AtomicU64] {
        // SAFETY: `start` is the page-aligned start of a live mapping of
        // `words` words, zero-filled or written only through atomics, and
        // `AtomicU64` has the layout of `u64`.
        unsafe { std::slice::from_raw_parts(self.start, self.words) }
    }
}

impl Drop for Mapping {
    fn drop(&mut self) {
        // SAFETY: the address and length are those of the mapping made in
        // `map`, which nothing else unmaps.
        unsafe {
            libc::munmap(self.start.cast(), self.words * 8);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    fn path(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("abai-shm-{label}-{}.region", std::process::id()))
    }

    #[test]
    fn two_mappings_of_one_segment_see_each_others_words() {
        let path = path("pair");
        let ours = Mapping::create(&path, 64).unwrap();
        let theirs = Mapping::open(&path).unwrap();
        assert_eq!(theirs.words().len(), 64);
        assert!(ours.words().iter().all(|w| w.load(Ordering::Relaxed) == 0));

        ours.words()[3].store(41, Ordering::SeqCst);
        theirs.words()[63].store(7, Ordering::SeqCst);
        assert_eq!(theirs.words()[3].load(Ordering::SeqCst), 41);
        assert_eq!(ours.words()[63].load(Ordering::SeqCst), 7);

        // a mapping outlives the other's end
        drop(ours);
        assert_eq!(theirs.words()[3].load(Ordering::SeqCst), 41);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn the_segment_is_the_owners_alone() {
        use std::os::unix::fs::PermissionsExt;
        let path = path("mode");
        let _mapping = Mapping::create(&path, 8).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn what_is_not_a_region_is_refused() {
        let path = path("bad");
        assert!(Mapping::open(&path).is_err());
        std::fs::write(&path, b"12345").unwrap();
        assert!(Mapping::open(&path).is_err());
        std::fs::write(&path, b"").unwrap();
        assert!(Mapping::open(&path).is_err());
        assert!(Mapping::create(&path, 0).is_err());
        std::fs::remove_file(path).unwrap();
    }
}
