#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
cargo build --manifest-path rust/Cargo.toml --target wasm32-unknown-unknown --release --locked
cp rust/target/wasm32-unknown-unknown/release/depth_kernels.wasm wasm/depth-kernels.wasm
