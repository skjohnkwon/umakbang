fn main() {
    let src = include_str!("../assets/icons/folder.svg").replace("currentColor", "#ff0000");
    match resvg::usvg::Tree::from_str(&src, &resvg::usvg::Options::default()) {
        Ok(tree) => {
            let mut pm = resvg::tiny_skia::Pixmap::new(14, 14).unwrap();
            resvg::render(&tree, resvg::tiny_skia::Transform::from_scale(14.0 / 24.0, 14.0 / 24.0), &mut pm.as_mut());
            let lit = pm.data().chunks_exact(4).filter(|p| p[3] > 0).count();
            println!("parsed ok, {lit} lit pixels of 196");
        }
        Err(e) => println!("parse error: {e}"),
    }
}
