//! The Devices section: this machine, and every other machine on the tailnet running umakbang,
//! each browsed in place. Nothing of another machine's library is copied into this one - a
//! folder over there is listed when it is opened or unfolded, kept for the session, and asked
//! again on a refresh. It replaced mounting a peer's library as a root, which downloaded its
//! whole index (hundreds of megabytes for a sample library) to look at one folder of it.
//!
//! Every folder over there gets an id here so the explorer, the tree, history and the panes can
//! hold it like one of this library's: negative, since the library's own ids start at 1 and its
//! virtual root is 0. An id stays with its folder for the session - a refresh lists it again
//! into the same node - so going back through history lands where it should.

use crate::library::{FileRow, FolderRow};
use crate::remote::{Listing, RemoteRoot};
use serde_json::Value;
use std::collections::HashMap;

/// Another machine, as its `/hello` describes it.
pub struct Device {
    /// The install's own id (`/hello`'s `device.id`): what a device is known by across a change
    /// of address or name.
    pub id: String,
    pub name: String,
    pub os: String,
    /// Answering now. A device that stops answering keeps its row, faded, so a folder of it that
    /// is open does not vanish from under the pointer.
    pub online: bool,
    /// The node that stands for it in the tree.
    pub top: i64,
}

/// A place on another machine: the device itself (`library` None, listing its libraries when it
/// has more than one), or a folder of one of its libraries.
pub struct Node {
    pub name: String,
    pub parent: Option<i64>,
    pub device: String,
    /// The library and the folder within it (`""` for the library's own folder).
    pub place: Option<(RemoteRoot, String)>,
    /// The subfolders as last listed; None until then.
    pub children: Option<Vec<i64>>,
    pub files: Vec<FileRow>,
    /// Files at or below, as the parent's listing gave it; None when nothing has said.
    pub count: Option<i64>,
    pub ratings: HashMap<String, u8>,
    pub tags: HashMap<String, Vec<String>>,
    pub loading: bool,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct Devices {
    pub devices: Vec<Device>,
    nodes: Vec<Node>,
}

fn id_of(index: usize) -> i64 {
    -(index as i64) - 1
}

fn index_of(id: i64) -> Option<usize> {
    (id < 0).then(|| (-id - 1) as usize)
}

/// Whether a folder id is on another machine.
pub fn is_device(id: i64) -> bool {
    id < 0
}

impl Devices {
    pub fn node(&self, id: i64) -> Option<&Node> {
        self.nodes.get(index_of(id)?)
    }

    fn node_mut(&mut self, id: i64) -> Option<&mut Node> {
        self.nodes.get_mut(index_of(id)?)
    }

    fn push(&mut self, node: Node) -> i64 {
        self.nodes.push(node);
        id_of(self.nodes.len() - 1)
    }

    pub fn device(&self, id: &str) -> Option<&Device> {
        self.devices.iter().find(|d| d.id == id)
    }

    /// Whether the machine a node is on is answering.
    pub fn online(&self, id: i64) -> bool {
        self.node(id).and_then(|n| self.device(&n.device)).is_some_and(|d| d.online)
    }

    /// What the tailnet says now. A device seen before keeps its nodes, and with them every
    /// folder already listed and every id history holds; its address and libraries are taken
    /// afresh, since either can have changed.
    pub fn update(&mut self, peers: &[crate::server::Peer]) {
        let mut seen = Vec::new();
        for peer in peers.iter().filter(|p| p.serving) {
            let (Some(hello), Some(host)) = (peer.hello.as_ref(), peer.node.ipv4.clone()) else { continue };
            let id = hello.pointer("/device/id").and_then(Value::as_str).unwrap_or("").to_string();
            if id.is_empty() {
                continue;
            }
            let name = if peer.node.host_name.is_empty() { peer.node.name.clone() } else { peer.node.host_name.clone() };
            let libraries: Vec<RemoteRoot> = hello
                .get("libraries")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|l| {
                    let text = |k: &str| l.get(k).and_then(Value::as_str).map(str::to_string);
                    Some(RemoteRoot { label: text("label")?, path: text("path")?, host: host.clone(), library_id: text("id")?, device_id: id.clone(), device_name: name.clone() })
                })
                .collect();
            for root in &libraries {
                crate::remote::register(root.clone());
            }
            seen.push(id.clone());
            match self.devices.iter().position(|d| d.id == id) {
                Some(at) => {
                    let top = self.devices[at].top;
                    // Back after not answering: what failed while it was away is worth asking again.
                    if !self.devices[at].online {
                        for node in self.nodes.iter_mut().filter(|n| n.device == id) {
                            node.error = None;
                        }
                    }
                    self.devices[at].name = name.clone();
                    self.devices[at].online = true;
                    self.devices[at].os = peer.node.os.clone();
                    if let Some(node) = self.node_mut(top) {
                        node.name = name.clone();
                    }
                    self.set_libraries(top, &libraries);
                }
                None => {
                    let top = self.push(Node::new(name.clone(), None, id.clone(), None));
                    self.devices.push(Device { id: id.clone(), name, os: peer.node.os.clone(), online: true, top });
                    self.set_libraries(top, &libraries);
                }
            }
        }
        for device in &mut self.devices {
            if !seen.contains(&device.id) {
                device.online = false;
            }
        }
        // Alphabetical, as the tree lists folders.
        self.devices.sort_by(|a, b| crate::columns::collate(&a.name, &b.name));
    }

    /// A device's libraries under its node. One library is the device: its folders are the
    /// device's children, with no level in between that only ever has one thing in it. Several
    /// get a node each.
    fn set_libraries(&mut self, top: i64, libraries: &[RemoteRoot]) {
        let device = self.node(top).map(|n| n.device.clone()).unwrap_or_default();
        match libraries {
            [only] => {
                let same = self.node(top).and_then(|n| n.place.as_ref()).is_some_and(|(r, _)| r.library_id == only.library_id);
                if let Some(node) = self.node_mut(top) {
                    if !same {
                        node.children = None;
                        node.files.clear();
                    }
                    node.place = Some((only.clone(), String::new()));
                }
            }
            _ => {
                let known: Vec<i64> = self.node(top).filter(|n| n.place.is_none()).and_then(|n| n.children.clone()).unwrap_or_default();
                let mut children = Vec::new();
                for root in libraries {
                    let reuse = known.iter().copied().find(|&c| self.node(c).and_then(|n| n.place.as_ref()).is_some_and(|(r, _)| r.library_id == root.library_id));
                    let child = match reuse {
                        Some(c) => {
                            if let Some(node) = self.node_mut(c) {
                                node.name = root.label.clone();
                                node.place = Some((root.clone(), String::new()));
                            }
                            c
                        }
                        None => self.push(Node::new(root.label.clone(), Some(top), device.clone(), Some((root.clone(), String::new())))),
                    };
                    children.push(child);
                }
                if let Some(node) = self.node_mut(top) {
                    node.place = None;
                    node.files.clear();
                    node.children = Some(children);
                }
            }
        }
    }

    /// What has to be asked to list `id`, marking it as being asked; None when it is already
    /// listed, being asked, or is a device whose libraries are its children.
    pub fn request(&mut self, id: i64, again: bool) -> Option<(RemoteRoot, String)> {
        let online = self.online(id);
        let node = self.node_mut(id)?;
        let place = node.place.clone()?;
        // A folder that failed is not asked again until a refresh, or the machine comes back:
        // the reply to a failure reopens the folder, and that must not ask again by itself.
        if node.loading || !online || (!again && (node.children.is_some() || node.error.is_some())) {
            return None;
        }
        node.loading = true;
        node.error = None;
        Some(place)
    }

    /// A folder's listing, into its node. A subfolder seen before keeps its node and id, so a
    /// refresh does not throw away what is open below it.
    pub fn fill(&mut self, id: i64, outcome: Result<Listing, String>) {
        let Some(node) = self.node(id) else { return };
        let (Some((root, dir)), device) = (node.place.clone(), node.device.clone()) else { return };
        let listing = match outcome {
            Ok(listing) => listing,
            Err(error) => {
                if let Some(node) = self.node_mut(id) {
                    node.loading = false;
                    node.error = Some(error);
                }
                return;
            }
        };
        let known: Vec<i64> = node.children.clone().unwrap_or_default();
        let mut children = Vec::new();
        for (name, count) in &listing.folders {
            let reuse = known.iter().copied().find(|&c| self.node(c).is_some_and(|n| &n.name == name));
            let child = match reuse {
                Some(c) => c,
                None => {
                    let within = if dir.is_empty() { name.clone() } else { format!("{dir}/{name}") };
                    self.push(Node::new(name.clone(), Some(id), device.clone(), Some((root.clone(), within))))
                }
            };
            if let Some(n) = self.node_mut(child) {
                n.count = Some(*count);
            }
            children.push(child);
        }
        children.sort_by(|a, b| crate::columns::collate(&self.nodes[index_of(*a).unwrap_or(0)].name, &self.nodes[index_of(*b).unwrap_or(0)].name));
        let total = listing.folders.iter().map(|(_, n)| n).sum::<i64>() + listing.files.len() as i64;
        if let Some(node) = self.node_mut(id) {
            node.children = Some(children);
            node.files = listing.files;
            node.ratings = listing.ratings;
            node.tags = listing.tags;
            node.loading = false;
            node.error = None;
            // The library's own folder has no parent listing to have counted it.
            node.count.get_or_insert(total);
        }
    }

    /// `id` as the explorer holds a folder. Its path is in the device scheme, which nothing here
    /// resolves to a folder on this machine - so no file operation can land in it.
    pub fn folder_row(&self, id: i64) -> Option<FolderRow> {
        let node = self.node(id)?;
        let path = match &node.place {
            Some((root, dir)) => root.path_of(dir),
            None => format!("{}{}", crate::remote::SCHEME, node.device),
        };
        Some(FolderRow { id, parent: node.parent, name: node.name.clone(), path, files: node.count.unwrap_or(0), latest: 0.0, has_children: node.children.as_ref().is_none_or(|c| !c.is_empty()) })
    }

    /// The listed subfolders of `id`, as folder rows.
    pub fn children(&self, id: i64) -> Vec<FolderRow> {
        self.node(id).and_then(|n| n.children.as_ref()).map(|c| c.iter().filter_map(|&c| self.folder_row(c)).collect()).unwrap_or_default()
    }

    /// The device and every folder down to `id`, outermost first: the breadcrumbs.
    pub fn ancestry(&self, id: i64) -> Vec<FolderRow> {
        let mut chain = Vec::new();
        let mut at = Some(id);
        while let Some(current) = at {
            let Some(row) = self.folder_row(current) else { break };
            at = row.parent;
            chain.push(row);
        }
        chain.reverse();
        chain
    }

    /// The node holding a file's folder, by the file's name in the device scheme: a track playing
    /// from another machine, located in the tree.
    pub fn folder_of(&self, path: &str) -> Option<i64> {
        let (dir, _) = path.rsplit_once('/')?;
        (0..self.nodes.len()).map(id_of).find(|&id| self.node(id).and_then(|n| n.place.as_ref()).is_some_and(|(root, within)| root.path_of(within) == dir))
    }

    /// The device a folder is on, for "Loading from …" and the like.
    pub fn device_name(&self, id: i64) -> String {
        self.node(id).and_then(|n| self.device(&n.device)).map(|d| d.name.clone()).unwrap_or_default()
    }
}

impl Node {
    fn new(name: String, parent: Option<i64>, device: String, place: Option<(RemoteRoot, String)>) -> Node {
        Node { name, parent, device, place, children: None, files: Vec::new(), count: None, ratings: HashMap::new(), tags: HashMap::new(), loading: false, error: None }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peer(id: &str, name: &str, libraries: Value) -> crate::server::Peer {
        crate::server::Peer {
            node: crate::tailscale::Node { id: name.into(), name: format!("{name}.ts.net"), host_name: name.into(), os: "macOS".into(), online: true, ipv4: Some("100.1.2.3".into()) },
            serving: true,
            hello: Some(serde_json::json!({ "app": "umakbang", "device": { "id": id }, "libraries": libraries })),
            reason: None,
        }
    }

    #[test]
    fn one_library_is_the_device() {
        let mut devices = Devices::default();
        devices.update(&[peer("mac", "Mac", serde_json::json!([{ "id": "lib1", "label": "Beats", "path": "/Users/me/Beats" }]))]);
        let top = devices.devices[0].top;
        let (root, dir) = devices.request(top, false).expect("asks the library's folder");
        assert_eq!((root.library_id.as_str(), dir.as_str()), ("lib1", ""));
        // Asked once at a time.
        assert!(devices.request(top, false).is_none());
        let mut listing = Listing::default();
        listing.folders = vec![("Drums".into(), 12), ("Bass".into(), 3)];
        devices.fill(top, Ok(listing));
        let kids = devices.children(top);
        assert_eq!(kids.iter().map(|k| k.name.as_str()).collect::<Vec<_>>(), vec!["Bass", "Drums"]);
        assert_eq!(kids[1].path, "umakbang-device://mac/lib1/Drums");
        assert_eq!(kids[1].files, 12);
        let crumbs = devices.ancestry(kids[1].id);
        assert_eq!(crumbs.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), vec!["Mac", "Drums"]);
        // A refresh lists into the same nodes, so their ids hold.
        let drums = kids[1].id;
        devices.request(top, true).expect("asked again");
        let mut again = Listing::default();
        again.folders = vec![("Drums".into(), 13)];
        devices.fill(top, Ok(again));
        assert_eq!(devices.children(top).iter().map(|k| k.id).collect::<Vec<_>>(), vec![drums]);
    }

    #[test]
    fn several_libraries_get_a_level_and_offline_keeps_the_row() {
        let mut devices = Devices::default();
        let libraries = serde_json::json!([{ "id": "a", "label": "Beats", "path": "/a" }, { "id": "b", "label": "Stems", "path": "/b" }]);
        devices.update(&[peer("pc", "PC", libraries.clone())]);
        let top = devices.devices[0].top;
        assert!(devices.request(top, false).is_none(), "a device with libraries under it lists nothing itself");
        assert_eq!(devices.children(top).len(), 2);
        let first = devices.children(top)[0].id;
        devices.update(&[]);
        assert!(!devices.devices[0].online);
        assert!(devices.request(first, false).is_none(), "nothing is asked of a machine that is not answering");
        devices.update(&[peer("pc", "PC", libraries)]);
        assert_eq!(devices.children(top)[0].id, first, "the same library keeps its node");
    }
}
