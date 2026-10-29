# Splat Lab v7 — dynamic PLY tiles, RAD & Spark scenes

Viewer dùng Spark **2.3.1**, Three.js **0.180.0**. Giữ các cảnh Cozy Spaceship,
Hobbiton, Coit Tower, Poland và Butterfly; giữ **Redandblack RAD/PLY dynamic** và
thêm **Redandblack PLY tiles** theo cấu trúc `layer_N/frame_N/voxels_new/*.ply`.
**Layer ở đây chính là resolution**: mỗi lần chọn một layer, không cộng các layer.

## Cập nhật bản Windows của bạn

1. Giải nén source.zip vào một thư mục tạm.
2. Chép các file mới vào `D:\3DGS-Spark-Vibe ver2`, ghi đè code cũ.
   **Giữ nguyên thư mục dữ liệu `dist/data` của bạn.** ZIP chỉ chứa code, không
   chứa dữ liệu PLY/RAD hoặc các cảnh mẫu của bên thứ ba.
3. Giải nén bộ `redandblack_tiles.zip`. Giữ nguyên tên thư mục layer, frame và tile.
4. Chạy trong **CMD**:

```bat
cd /d "D:\3DGS-Spark-Vibe ver2"
py configure_tiles.py --input "D:\Downloads\redandblack_tiles\redandblack_tiles" --copy
py serve.py --bind 127.0.0.1 --port 8765 --directory dist
```

Mở **http://127.0.0.1:8765/**. Nhấn Ctrl+F5 nếu còn giao diện cũ.
Thay đường dẫn `--input` nếu bạn giải nén ở chỗ khác. Script nhận cả thư mục bọc
ngoài có thêm một thư mục redandblack_tiles bên trong. Nó chép các PLY vào
`dist/data/redandblack_tiles`, giữ nguyên nội dung file gốc và tạo `tiles.json`.
Mở trang sẽ tự chọn cảnh tile khi dataset có sẵn; người xem không phải chọn file.

Không cần Cargo, npm hoặc chuyển sang RAD để xem PLY tiles. Cần Internet để tải
engine/CDN và các cảnh mẫu Spark.
Không mở index.html bằng `file://`.

## Cấu trúc layer / frame / tile

Ví dụ sau khi chạy lệnh cấu hình:

| Đường dẫn trong project                                                   | Ý nghĩa                                                 |
| ------------------------------------------------------------------------- | ------------------------------------------------------- |
| `dist/data/redandblack_tiles/tiles.json`                                  | Danh sách resolution, frame và URL từng tile            |
| `dist/data/redandblack_tiles/layer_1/frame_1450/voxels_new/x_1y_1z_1.ply` | Một tile không gian của frame 1450, resolution layer_1  |
| `dist/data/redandblack_tiles/layer_1/frame_1450/voxels_new/x_2y_1z_1.ply` | Tile khác của cùng frame, hiển thị cùng lúc             |
| `dist/data/redandblack_tiles/layer_1/frame_1451/voxels_new/x_1y_1z_1.ply` | Tile của frame kế tiếp                                  |
| `dist/data/redandblack_tiles/layer_2/frame_1450/voxels_new/x_1y_1z_1.ply` | Frame 1450 ở resolution layer_2, nếu dataset có layer_2 |

Không đổi tên layer thành res1/res2/res4/res8. Web liệt kê đúng các layer tìm thấy.
Script chọn mặc định layer có tổng dung lượng tile nhỏ nhất; số layer không được
dùng để suy đoán độ nặng hay kích thước ảnh. Các layer phải có cùng danh sách frame,
nhưng số lượng/tên tile của từng frame có thể khác nhau. Không cần đúng 30 frame.

Nếu bạn đã tự chép data vào `dist/data/redandblack_tiles`, chỉ cần:

```bat
py configure_tiles.py
```

Tùy chọn: `--default-layer layer_1`, `--fps 30`, `--rotation -90`,
`--start 1450 --end 1479`. Chỉ dùng tên layer có thật. Sau khi thay đổi dữ liệu,
chạy lại script để cập nhật danh sách và kích thước tile. Tùy chọn copy không xóa
file cũ tại đích. Script không ghép, chuyển đổi hay giảm chất lượng PLY.

**Điều kiện của PLY:** tile chứa Gaussian 3D với các thuộc tính chuẩn `x/y/z`,
`opacity`, `f_dc_*`, `scale_*`, `rot_*`. Script kiểm tra header và độ dài dữ liệu
binary, bỏ qua tile `element vertex 0` khi lập danh sách tải. File ASCII và binary
little-endian được nhận. Đây không phải kiểm tra chất lượng reconstruction.
Các tile phải dùng **chung hệ tọa độ của frame**. Nếu quy trình xuất đã đưa từng
tile về gốc riêng, cần cung cấp transform/offset tương ứng trước khi ghép đúng;
tên `x_…y_…z_…` không đủ xác định offset theo đơn vị thế giới.

## Cách phát tile qua Spark

- Trình duyệt đọc `tiles.json`, sau đó GET từng PLY qua HTTP. Một frame là một
  `THREE.Group` chứa các `SplatMesh` đã giải mã, giữ nguyên tọa độ từng tile.
- Tải song song tối đa 3 tile mặc định, chỉnh 1–6 trong công cụ. Các bước giải mã
  được xếp hàng để tránh tạo quá nhiều công việc/buffer cùng lúc.
- Chỉ chuyển sang nhóm mới khi toàn bộ tile không rỗng của frame đó đã sẵn sàng.
  Frame đang xem vẫn hiển thị trong lúc chờ; thiếu một tile thì báo URL lỗi.
- Buffer mặc định 2 frame, có thể thêm một frame đang chuẩn bị. Tải trước, tua,
  lặp, hủy tải khi đổi cảnh và giải phóng mesh cũ đều được hỗ trợ. Không chờ tải
  hết cả chuỗi mới bắt đầu phát.
- Chọn resolution giữ tên frame và camera; cần tải lại frame ở layer mới nên có
  thể có khoảng chờ khi đổi layer. Các layer là lựa chọn thay thế, không cộng dồn.
- Công cụ hiển thị số tile/frame, tiến độ tải, dung lượng đã tải, FPS nội dung và
  FPS render. CSV có thêm số tile và tiến độ chuẩn bị frame.

**Phạm vi streaming:** phiên bản này tải đủ các tile không rỗng của frame ở layer
đang chọn. Chưa lọc tile theo vùng nhìn, chưa trộn resolution giữa các tile và
chưa tự chọn layer theo tốc độ mạng. Đây chưa phải LoD không gian như RAD của
Spark. Các cảnh RAD vẫn giữ cơ chế tải chunk theo góc nhìn của Spark.

Nhiều file nhỏ có chi phí HTTP, giải mã và quản lý mesh; chia tile tự nó không
bảo đảm nhanh hơn một PLY nguyên frame, cũng không bảo đảm 30 FPS. Buffer giới hạn
theo số frame, không phải tổng byte: frame quá lớn vẫn có thể tốn nhiều RAM/VRAM.
Giảm resolution hoặc buffer nếu máy thiếu bộ nhớ. Không có codec nén liên frame.

Để dùng server dữ liệu riêng, tạo manifest ngay tại thư mục dataset:

```bat
py configure_tiles.py --input "D:\data\redandblack_tiles" --output "D:\data\redandblack_tiles"
```

Phục vụ cả thư mục đó qua HTTP/HTTPS, rồi nhập URL `tiles.json` ở Công cụ → Dynamic
→ Mở thêm chuỗi → Mở chuỗi tile. Server khác origin cần cho phép CORS cho cả JSON
và PLY. Để mọi người mặc định thấy dataset này, sửa `manifestUrl` trong scene
`redandblack-tiles` của `dist/scenes.js`.

## Cấu trúc RAD

Ví dụ các đường dẫn tương đối với thư mục project:

| File                                                 | Vai trò                 |
| ---------------------------------------------------- | ----------------------- |
| `dist/data/redandblack-pages/res8/001450-lod.rad`    | Header frame 1450, res8 |
| `dist/data/redandblack-pages/res8/001450-lod-0.radc` | Chunk 0 của frame đó    |
| `dist/data/redandblack-pages/res8/001450-lod-1.radc` | Chunk tiếp theo, nếu có |
| `dist/data/redandblack-pages/res8/001451-lod.rad`    | Frame kế tiếp           |
| `dist/data/redandblack-pages/res1/001450-lod.rad`    | Cùng frame ở res1       |

Giữ tiếp các frame đến 001479 và các resolution res1/res2/res4/res8.
Số chunk mỗi frame có thể khác nhau. Không đổi đuôi RADC thành RAD.

`configure_dataset.py` nhận cả tên `001450-lod.rad`, `001450.rad` và các tên khác,
sắp xếp tự nhiên, chỉ liệt kê resolution thật sự có dữ liệu. Các resolution của
cùng định dạng phải có cùng danh sách tên frame để đổi chất lượng đúng thời điểm.
Nó đọc header RAD để kiểm tra cây LoD, sự tồn tại/kích thước/chữ ký của từng chunk.
Đây không phải kiểm thử giải mã hoặc kiểm tra chất lượng hình ảnh.

Chạy `py configure_dataset.py` cho dữ liệu RAD/PLY nguyên frame.
Script tạo **`dist/data/redandblack-scenes.json`**; web tự đọc file này khi mở.
Không sửa hay chuyển đổi dữ liệu gốc. Sau khi bổ sung frame/resolution, chạy lại
script. Script in ra số frame thực tế; hãy kiểm tra đủ 30 frame mỗi resolution.
Nếu chỉ chuyển xong một phần dữ liệu, script không tự tạo các frame còn thiếu.

Nếu chưa chạy script, `scenes.js` mặc định tìm:

- RAD: `res1|res2|res4|res8/001450-lod.rad` đến `001479-lod.rad`.
- PLY: `res1|res2|res4|res8/001450.ply` đến `001479.ply`.

RAD mặc định dùng **buffer 3 frame**, res8, FPS mục tiêu 30, tự phát và lặp.
Lúc mở trang: thử **PLY tiles → RAD → PLY nguyên frame → Butterfly**, tùy dữ liệu
có sẵn. Nếu không có dataset, thông báo xuất hiện trong công cụ.
Khi chọn RAD thủ công mà có lỗi, web báo lỗi thay vì âm thầm chuyển sang cảnh khác.

## Giao diện

- Canvas chiếm toàn bộ cửa sổ. Bảng công cụ mặc định đóng.
- Bấm **Công cụ**, hoặc phím **H** để mở/đóng. Escape đóng bảng.
- Tên cảnh, tác giả, lựa chọn scene, resolution, timeline, FPS và các thông số
  đều nằm trong bảng. Khi đóng chỉ còn cảnh và một nút mở công cụ.
- Trong Dynamic: Phát/Tạm dừng, tua frame, lặp, buffer, FPS mục tiêu, xoay X,
  Vừa khung. Space phát/tạm dừng khi canvas đang được focus.
- Đổi resolution giữ cùng tên frame, trạng thái phát và vị trí camera.
- Toàn màn hình vẫn có nút mở/đóng công cụ.
- Các điều khiển LoD/foveation, camera, tự xoay, background, thêm đối tượng và
  xuất số đo CSV của bản trước được giữ lại.
- Lỗi mới sẽ mở bảng để hiển thị thông báo. Nút đóng/mở và hướng dẫn vẫn hoạt động
  nếu engine/CDN/WebGL không khởi tạo được.

Nếu nhân vật nằm ngang: mở Dynamic, đổi **Xoay X = -90**, bấm **Vừa khung**.
Để lưu hướng đó cho mọi người xem, sửa `rotationX` của scene trong `scenes.js`.

## Dynamic RAD hoạt động như thế nào?

Mỗi frame RAD được tạo bằng **`new SplatMesh({ url, paged: true })`**. Giữ URL gốc
để Spark tìm đúng các file RADC và tải chunk theo góc nhìn. RAD gộp dùng HTTP Range.
Không tải header thành một ArrayBuffer rồi đưa vào bộ đọc PLY.

Bộ phát duy trì một cửa sổ frame nhỏ. Mesh RAD được chuẩn bị với opacity = 0 nhưng
vẫn tham gia bộ chọn LoD của Spark. `mesh.initialized` chỉ là bước đầu; bộ phát chờ
metadata hợp lệ và `mesh.paged.numSplats > 0` rồi mới chuyển opacity giữa các frame.
Frame trước được giữ trong lúc frame tiếp theo đang chuẩn bị. Buffer được giới
hạn 2–10 frame; có thể có thêm một frame đang chuẩn bị.

Các frame trong buffer vẫn được cập nhật LoD theo góc nhìn để tránh phải khởi tạo
lại từ đầu khi đến lượt phát. Chỉ **một frame có opacity > 0**. Đánh đổi: các frame
trong buffer dùng chung ngân sách LoD và thêm công việc traversal/packing/sorting.
Nếu máy chậm, thử buffer 2–3 và giảm ngân sách splat hoặc độ phân giải render.
Các page GPU cũ được Spark giải phóng theo cơ chế cleanup, không nhất thiết ngay
trong lần chuyển frame. Header fetch do Spark quản lý có thể kết thúc sau thao tác
hủy; kết quả cũ bị bỏ, chunk fetch được hủy khi dispose.

**Giới hạn cần hiểu:**

- RAD là LoD/nén theo không gian của từng frame, không phải codec video theo thời gian.
- Frame có splat được chọn chưa có nghĩa là đã đủ tất cả chi tiết. Hình có thể sắc
  dần khi chunk được tải, và thay đổi camera có thể gây tải thêm dữ liệu.
- Điều kiện sẵn sàng trên không phải GPU fence hay xác nhận frame đã present.
- Đổi resolution bắt đầu buffer mới; có thể có khoảng chờ. Camera và thời điểm
  trong chuỗi được giữ lại.
- 30 file không tự bảo đảm 30 FPS. Không bỏ frame hay nội suy để bám đồng hồ.
- FPS render đo vòng lặp trình duyệt. FPS nội dung đo lần ứng dụng đổi mesh.
  Số splat được chọn gồm cả các frame trong buffer RAD đang tham gia LoD.
- Thời gian chuẩn bị frame gồm tải, giải mã và chờ LoD; không phải riêng decode.
- PLY vẫn dùng `lod:false` và buffer mesh đã giải mã như trước.
- Chưa có decoder CAGS/Draco/CPGS/NPZ hoặc ABR/DASH.

RAD cần cây LoD từ build-lod. Định dạng khác hoặc RAD chưa có LoD sẽ báo lỗi.
Nếu sau 45 giây frame chưa có splat, bộ phát dừng với thông báo để kiểm tra
RADC, HTTP Range/CORS và công tắc Tải thêm chunk. Phát thử lại sau khi sửa lỗi.

## Đưa lên GitHub Pages

Khi đã có dữ liệu trong `dist/data`, tại thư mục project chạy:

```bat
py prepare_pages.py
git add docs
git commit -m "Add Spark tiled dynamic playback and resolution selection"
git push
```

Script kiểm tra dữ liệu, tạo danh sách frame, chép **toàn bộ dist** sang docs và tạo
`.nojekyll`. Nó hỗ trợ chỉ PLY tiles, chỉ RAD/PLY nguyên frame, hoặc kết hợp,
bao gồm các chunk RADC. Với tiles.json đã có, giữ layer mặc định, FPS, hướng xoay
và khoảng frame đã chọn; chạy lại configure_tiles.py trước để cập nhật lựa chọn.
Không xóa file cũ trong docs; nếu đổi tên/xóa frame nguồn, danh sách mới sẽ ngừng
tham chiếu các file cũ nhưng chúng vẫn tồn tại trong docs cho đến khi bạn dọn.

Giữ Settings → Pages → Deploy from a branch → main → /docs nếu đang dùng cách này.
Nếu chỉ cập nhật giao diện, dữ liệu và danh sách trong docs đã đúng:

```bat
py prepare_pages.py --frontend-only
```

Lệnh frontend-only giữ nguyên cả dataset và danh sách dữ liệu trong docs.
Kiểm tra giới hạn dung lượng hiện hành của dịch vụ trước khi push bộ dữ liệu lớn.
Có thể lưu dữ liệu ở server HTTP khác; sửa `baseUrl` trong scenes.js hoặc file
redandblack-scenes.json (cấu hình trong JSON được ưu tiên). Server khác origin cần
CORS; RAD gộp cần phản hồi Range **206** đúng với Content-Range. `serve.py` đi kèm
đã hỗ trợ Range. Không dùng `py -m http.server` cho thử RAD gộp vì không bảo đảm Range.

## Thêm scene / mở URL riêng

Chỉnh `dist/scenes.js`. Một scene sequence tối thiểu:

```js
{
  id: 'my-rad',
  type: 'sequence',
  name: 'My RAD sequence',
  autoplay: true,
  sequence: {
    baseUrl: './data/my-scene/',
    format: 'rad',
    filePattern: '{frame}-lod.rad',
    firstFrame: 1450,
    lastFrame: 1479,
    padding: 6,
    resolutions: ['res1', 'res2', 'res4', 'res8'],
    defaultResolution: 'res8',
    fps: 30,
    buffer: 3,
    rotationX: 0,
  },
}
```

Nếu tên là `001450.rad`, đặt `filePattern: '{frame}.rad'`.
Có thể dùng `framesByResolution` chứa danh sách tên file rõ ràng thay khoảng số.
URL tương đối chạy được ở localhost và dưới `/TEN_REPOSITORY/` của GitHub Pages.
Chia sẻ link `?scene=redandblack-rad&res=res4`, `?scene=redandblack&res=res2`
hoặc `?scene=redandblack-tiles&res=layer_1`, `?scene=hobbit`.
Mặc định sửa tại `viewerSettings.defaultSceneId`.

Không cần sửa code để thử một URL: Công cụ → Dynamic → Mở thêm chuỗi →
Mở chuỗi qua URL. Chọn định dạng, mẫu tên, các resolution hiện có và khoảng frame.
Người xem vẫn có thể mở PLY từ máy trong mục nâng cao; đây là xử lý cục bộ, không
upload. RAD chia chunk được mở qua HTTP để Spark tìm các file liên quan.

## Source và kiểm tra

Code HTML/CSS/JS đã format, không minify:

- `index.html`, `style.css`, `ui.js`: canvas và bảng công cụ có thể đóng/mở.
- `app.js`: renderer, camera, scene coordinator và số đo.
- `sequence.js`: URLs, timeline, buffer, chuẩn bị PLY/RAD và dọn dữ liệu.
- `tiles.js`: đọc manifest, tải có giới hạn, giải mã và nhóm các tile theo frame.
- `scenes.js`: các cảnh mẫu và cấu hình mặc định.
- `configure_dataset.py`: lập danh sách dữ liệu thực và kiểm tra RAD/RADC.
- `configure_tiles.py`: đọc header PLY, lập manifest layer/frame/tile và chép dữ liệu.
- `prepare_pages.py`: chuẩn bị docs cho Pages.

```bat
node --test tests/*.test.mjs
py -m unittest discover -s tests -p "test_*.py"
```

24 kiểm tra Node và 14 kiểm tra Python đã chạy thành công. Kiểm tra logic gồm
manifest tile, tọa độ không bị thay đổi, giới hạn tải/giải mã, không hiển thị frame
chưa đủ tile, hủy tải/dọn mesh, file rỗng/lỗi và đóng gói dataset tile cho Pages;
URL dưới thư mục repo, tên RAD/RADC, thứ tự frame, autoplay,
seek, đổi resolution, giới hạn buffer, hủy frame cũ, không coi header là frame sẵn
sàng, lỗi metadata và fallback. Python kiểm tra dữ liệu trước khi copy và HTTP Range.
Fixture Python chỉ kiểm tra header/chunk bounds, không phải một cảnh render được.

Môi trường tạo mã đã kiểm tra UI đóng/mở bằng trình duyệt, nhưng trình duyệt đó
không tạo được WebGL context. Chưa xác nhận hình render/FPS của bộ PLY tile hoặc
RAD Redandblack thật trên máy của bạn; các file thật chưa được cung cấp trong lần
cập nhật này. Chạy localhost với layer nhẹ nhất trước. Kiểm tra Network: JSON và
PLY (hoặc RAD/RADC) phải tải thành công; không có lỗi ở Console. Các kiểm tra dùng
mock engine chỉ xác minh logic, không thay cho kiểm tra Spark/GPU trên dữ liệu thật.

## Nguồn

- https://sparkjs.dev/docs/lod-getting-started/
- https://sparkjs.dev/docs/splat-mesh/
- https://sparkjs.dev/examples/streaming-lod/
- API đối chiếu theo https://github.com/sparkjsdev/spark/tree/v2.3.1

Spaceship: Britt Casado / World Labs Marble; Hobbiton: Tijerin / World Labs Marble;
Coit Tower: Vincent Woo; Poland: Andrii Shramko; Butterfly: Spark example asset.
Không đóng gói lại các dataset mẫu. Đây là ứng dụng dựa trên Spark, không phải
sản phẩm chính thức của World Labs. Mã giao diện riêng dùng LICENSE kèm source.
