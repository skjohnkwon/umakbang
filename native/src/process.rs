//! Child processes that should not be seen. On Windows a console program started from a
//! windowed app flashes a console over it unless told `CREATE_NO_WINDOW`; elsewhere there is
//! nothing to hide.

use std::process::Command;

/// `command`, set not to open a window of its own.
pub fn quiet(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
}
