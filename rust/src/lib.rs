//! Pixel kernels. The JS adapter owns bounds checks and an aligned scratch arena.
use std::cell::RefCell;
thread_local! { static ARENA: RefCell<Vec<u64>> = const { RefCell::new(Vec::new()) }; }

#[no_mangle]
pub extern "C" fn reserve(bytes: usize) -> *mut u64 {
    ARENA.with(|arena| {
        let mut arena = arena.borrow_mut();
        arena.resize(bytes.div_ceil(8), 0);
        arena.as_mut_ptr()
    })
}
fn byte(x: f64) -> u8 { x.clamp(0.0, 255.0).round() as u8 }
fn window(d: f64, half: f64, softness: f64, profile: f64, reverse: bool) -> f64 {
    let a = d.abs();
    if a > half { return 0.0; }
    if profile == 1.0 { return 1.0; }
    let feather = half * softness / 100.0;
    let u = ((a - (half - feather)) / feather).clamp(0.0, 1.0);
    let mut value = if feather < 1e-9 { 1.0 } else { 1.0 - u*u*(3.0-2.0*u) };
    if profile == 2.0 {
        let ramp = (0.5 + d / (2.0 * half)).clamp(0.0, 1.0);
        value *= if reverse { 1.0-ramp } else { ramp };
    }
    value
}
fn shape(mut v: f64, c: &[f64]) -> u8 {
    if c[12] != 1.0 && v > 0.0 && v < 1.0 {
        let u = v.powf(c[15]);
        v = (u / (u + (1.0-v).powf(c[15]))).powf(1.0/c[16]);
    }
    v = c[17] + (1.0-c[17])*v;
    byte(if c[18] != 0.0 { (1.0-v)*255.0 } else { v*255.0 })
}
/// Config: plane A xy z constant, plane B, sx sy, half A B,
/// profile, softness A B, contrast lift background invert reverse second.
#[no_mangle]
pub unsafe extern "C" fn spatial(rgba: *mut u8, depth: *const u16, table: *const u8,
    config: *const f64, width: usize, height: usize, rows: usize, offset_y: usize) {
    let out = std::slice::from_raw_parts_mut(rgba, width*rows*4);
    let depth = std::slice::from_raw_parts(depth, width*rows);
    let table = std::slice::from_raw_parts(table, 65536);
    let c = std::slice::from_raw_parts(config, 21);
    let no_depth = shape(0.0, c);
    for y in 0..rows {
        let wy = (0.5-(y as f64+offset_y as f64+0.5)/height as f64)*c[9];
        let ra = c[1]*wy-c[3]-0.5*c[2];
        let rb = c[5]*wy-c[7]-0.5*c[6];
        for x in 0..width {
            let pos = y*width+x;
            let value = if depth[pos] == 16383 { no_depth } else {
                let wx = ((x as f64+0.5)/width as f64-0.5)*c[8];
                let t = depth[pos] as f64 * (1.0/16382.0);
                let mut w = window(c[0]*wx+c[2]*t+ra,c[10],c[13],c[12],c[19]!=0.0);
                if c[20]!=0.0 { w = w.max(window(c[4]*wx+c[6]*t+rb,c[11],c[14],c[12],c[19]!=0.0)); }
                if w>0.0 && w<1.0 && (w<0.001 || w>0.999) { shape(w,c) }
                else { table[(w.clamp(0.0,1.0)*65535.0).round() as usize] }
            };
            out[pos*4] = value; out[pos*4+1] = value; out[pos*4+2] = value;
        }
    }
}

/// Build the flat/hue tone lookup and apply it without crossing JS per pixel.
/// Final config entries: centers A/B, hue flag. RGBA words are little-endian.
#[no_mangle]
pub unsafe extern "C" fn flat(rgba: *mut u32, depth: *const u16, config: *const f64, count: usize) {
    let out = std::slice::from_raw_parts_mut(rgba, count);
    let depth = std::slice::from_raw_parts(depth, count);
    let c = std::slice::from_raw_parts(config, 24);
    let mut table = [0u32; 16384];
    for (i, slot) in table.iter_mut().enumerate().take(16383) {
        let t = i as f64 / 16382.0;
        let mut da = t-c[21]; let mut db = t-c[22];
        if c[23]!=0.0 { da = ((da+1.5)%1.0)-0.5; db = ((db+1.5)%1.0)-0.5; }
        let mut weight = window(da,c[10],c[13],c[12],c[19]!=0.0);
        if c[20]!=0.0 { weight=weight.max(window(db,c[11],c[14],c[12],c[19]!=0.0)); }
        *slot = shape(weight,c) as u32 * 0x010101;
    }
    table[16383] = shape(0.0,c) as u32 * 0x010101;
    for (pixel, &d) in out.iter_mut().zip(depth) {
        *pixel = (*pixel & 0xff000000) | table.get(d as usize).copied().unwrap_or(0);
    }
}

// Independent workspaces keep detail passes from evicting retained focus inputs.
thread_local! { static TEXTURE_ARENAS: RefCell<[Vec<u64>; 2]> = const { RefCell::new([Vec::new(),Vec::new()]) }; }
#[no_mangle]
pub extern "C" fn reserve_texture(bytes: usize, slot: usize) -> *mut u64 {
    TEXTURE_ARENAS.with(|arenas| {
        let mut arenas=arenas.borrow_mut();let arena=&mut arenas[slot.min(1)];
        arena.resize(bytes.div_ceil(8),0);arena.as_mut_ptr()
    })
}
thread_local! { static DETAIL_OUTPUT: RefCell<Vec<u64>> = const { RefCell::new(Vec::new()) }; }
#[no_mangle]
pub extern "C" fn reserve_detail(bytes: usize) -> *mut u64 {
    DETAIL_OUTPUT.with(|arena|{let mut arena=arena.borrow_mut();arena.resize(bytes.div_ceil(8),0);arena.as_mut_ptr()})
}
#[no_mangle]
pub unsafe extern "C" fn detail_lookup(rgba: *mut u32, texture: *const u8, table: *const u8,
    count: usize, stride: usize, opacity: f64, overlay: usize) {
    let out=std::slice::from_raw_parts_mut(rgba,count);
    let tex=std::slice::from_raw_parts(texture,count*stride);
    let table=std::slice::from_raw_parts(table,65536);
    for (i,pixel) in out.iter_mut().enumerate() {
        let alpha=tex[i*stride+stride-1];
        if *pixel>>24==0 || alpha==0 { continue; }
        let b8=(*pixel&255) as usize;let d8=tex[i*stride] as usize;
        let v=if alpha==255 { table[b8*256+d8] } else {
            let b=b8 as f64/255.0;let d=d8 as f64/255.0;
            let a=opacity*alpha as f64/255.0;
            let mixed=if overlay==0 { b*d } else if b<=0.5 { 2.0*b*d } else { 1.0-2.0*(1.0-b)*(1.0-d) };
            byte((b+a*(mixed-b)).clamp(0.0,1.0)*255.0)
        };
        *pixel=(*pixel&0xff000000) | v as u32*0x010101;
    }
}
