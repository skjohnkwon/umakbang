//! Stamps the logo and version details into the exe.
//!
//! Windows draws a shortcut's icon, the Apps list entry and the file in Explorer from the
//! exe's own resources. Without them every one of those was the generic application frame,
//! however often Explorer was restarted, because there was no icon there for it to find.
//! The window and the tray set their icons at run time and were never affected.

fn main() {
    println!("cargo:rerun-if-changed=assets/icon.ico");
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let version = std::env::var("CARGO_PKG_VERSION").unwrap();
    let mut parts: Vec<u32> = version.split(['.', '-']).filter_map(|p| p.parse().ok()).collect();
    parts.resize(4, 0);
    let numeric = parts.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
    let icon = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("assets").join("icon.ico");
    // Id 1 is the lowest icon id, which is the one the shell uses for the file itself.
    let rc = format!(
        r#"1 ICON "{icon}"

1 VERSIONINFO
FILEVERSION {numeric}
PRODUCTVERSION {numeric}
FILEOS 0x40004
FILETYPE 0x1
BEGIN
  BLOCK "StringFileInfo"
  BEGIN
    BLOCK "040904B0"
    BEGIN
      VALUE "CompanyName", "umakbang"
      VALUE "FileDescription", "umakbang"
      VALUE "FileVersion", "{version}"
      VALUE "InternalName", "umakbang"
      VALUE "OriginalFilename", "umakbang.exe"
      VALUE "ProductName", "umakbang"
      VALUE "ProductVersion", "{version}"
    END
  END
  BLOCK "VarFileInfo"
  BEGIN
    VALUE "Translation", 0x409, 1200
  END
END
"#,
        icon = icon.display().to_string().replace('\\', "\\\\"),
    );
    let out = std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("umakbang.rc");
    std::fs::write(&out, rc).unwrap();
    embed_resource::compile(&out, embed_resource::NONE).manifest_optional().unwrap();
}
