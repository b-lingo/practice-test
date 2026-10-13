# B-Lingo – bản triển khai chính thức (web tĩnh)

Gồm 3 file:
- `index.html` – toàn bộ ứng dụng (một file, chạy ngay).
- `ai-proxy-worker.js` – máy chủ AI mẫu (Cloudflare Worker), giữ khóa API an toàn. Chỉ cần nếu muốn bật chức năng AI.
- `README.md` – hướng dẫn này.

## Cách 1. Dùng ngay không cần cài gì
Mở `index.html` bằng Chrome/Edge. Các chức năng không dùng AI chạy đầy đủ: quản lý lớp, kho đề, soạn tay, số hóa đề, giao bài, phòng thi thử, xuất Word/Excel.
Chức năng AI (Tạo đề bằng AI, Luyện nói, nhận xét AI) cần Cách 3.

## Cách 2. Đưa lên mạng bằng GitHub Pages (miễn phí)
1. Đăng ký/đăng nhập github.com → **New repository** → tên ví dụ `b-lingo`, chọn **Public** → Create.
2. Bấm **uploading an existing file**, kéo `index.html` vào → **Commit changes**.
3. Vào **Settings → Pages** → mục *Build and deployment*: Source = **Deploy from a branch**, Branch = **main** / **(root)** → Save.
4. Chờ 1–2 phút. Địa chỉ app: `https://TEN-GITHUB-CUA-BAN.github.io/b-lingo/`
5. Muốn cập nhật: vào repository, bấm file `index.html` → biểu tượng bút chì (hoặc Upload files) → thay bằng bản mới → Commit.

Phương án khác: Netlify Drop (netlify.com/drop) – kéo thả thư mục chứa `index.html`, có link ngay. Cloudflare Pages cũng tương tự.

## Cách 3. Bật chức năng AI (tùy chọn)
Không được dán khóa API trực tiếp vào `index.html` vì ai mở trang cũng thấy và dùng trộm. Cần một "máy chủ trung gian" nhỏ giữ khóa:
1. Lấy khóa API tại console.anthropic.com (có tính phí theo lượng dùng).
2. Đăng ký cloudflare.com (miễn phí) → **Workers & Pages → Create → Create Worker**, đặt tên `blingo-ai`, bấm **Deploy**, rồi **Edit code**, dán toàn bộ `ai-proxy-worker.js`, **Deploy**.
3. Worker → **Settings → Variables and Secrets**: thêm Secret `ANTHROPIC_API_KEY` = khóa của bạn; thêm biến `ALLOWED_ORIGIN` = địa chỉ app, ví dụ `https://TEN.github.io` (chỉ trang của bạn được gọi).
4. Chép địa chỉ Worker (dạng `https://blingo-ai.xxx.workers.dev`), mở `index.html` bằng Notepad, tìm dòng
   `window.BLINGO_CONFIG=window.BLINGO_CONFIG||{aiEndpoint:""};`
   sửa thành `{aiEndpoint:"https://blingo-ai.xxx.workers.dev"}` rồi tải lại lên GitHub.
5. Nên đặt hạn mức chi tiêu trong console.anthropic.com để tránh phát sinh ngoài ý muốn.

Lưu ý: máy chủ mẫu này chưa có đăng nhập người dùng. Ai biết địa chỉ trang đều gọi được AI (tốn tiền của bạn). Với số ít người dùng thử thì đặt `ALLOWED_ORIGIN` và hạn mức chi tiêu là đủ; triển khai rộng cần thêm đăng nhập thật (hướng Firebase).

## Giới hạn của bản web tĩnh
- Dữ liệu (lớp, đề, bài giao) lưu **trong trình duyệt của từng người**, không đồng bộ giữa các máy. Đổi máy hoặc xóa dữ liệu trình duyệt sẽ mất → nhắc người dùng xuất Word/Excel để sao lưu.
- Đăng nhập chỉ để tách dữ liệu trong một trình duyệt, không phải bảo mật thật.
- Học sinh chưa nộp bài trực tiếp được (dùng file bài thi và mã kết quả). Muốn nộp trực tiếp, lưu dữ liệu nhiều máy và đăng nhập thật cần chuyển sang nền tảng có máy chủ (Firebase).
- Thư viện đọc/ghi Excel, Word tải từ cdnjs.cloudflare.com và font từ Google Fonts nên cần có mạng.
