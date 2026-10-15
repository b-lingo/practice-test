# B-Lingo – Trợ lý Giảng dạy & Quản trị Tiếng Anh (Multi-User Cloud & Server-Side AI)

B-Lingo là nền tảng quản trị và trợ lý giảng dạy tiếng Anh thông minh dành cho giáo viên THCS/THPT, hỗ trợ nhiều người dùng trên nền tảng Firebase và gọi AI Gemini bảo mật phía máy chủ Node.js Express.

## Kiến trúc & Cấu hình AI phía máy chủ

### 1. Endpoint AI Server: `POST /api/ai`
- **Xác thực bảo mật**: Kiểm tra Firebase ID Token trong header `Authorization: Bearer <token>`. Từ chối người dùng chưa đăng nhập (HTTP 401/403).
- **Giới hạn tần suất (Rate Limiting)**: Tối đa **30 yêu cầu / phút** và **800 yêu cầu / ngày** cho mỗi tài khoản giáo viên. Khi vượt giới hạn trả HTTP 429.
- **Không để lộ khóa**: Toàn bộ yêu cầu AI được xử lý trên máy chủ. Khóa `BLINGO_GEMINI_KEY` nằm hoàn toàn ở môi trường server, không bao giờ gửi xuống client.
- **Mô hình**: Đọc từ biến `GEMINI_MODEL` (mặc định `gemini-3.8-flash`). `maxOutputTokens: 24000`, `temperature: 0.7`.
- **Định dạng phản hồi**: `{ "text": "...", "truncated": true/false }`.

### 2. Thiết lập biến môi trường (Environment Variables)
Tạo file `.env` tại thư mục gốc của dự án (tham khảo file `.env.example`):
```env
# Khóa API Gemini lấy từ https://aistudio.google.com
BLINGO_GEMINI_KEY=your_gemini_api_key_here

# Mô hình AI tùy chọn (mặc định gemini-3.8-flash)
GEMINI_MODEL=gemini-3.8-flash

# Cổng máy chủ (mặc định 3000)
PORT=3000
```

## Tính năng chính của B-Lingo

- **Hệ thống Đăng nhập & Đa người dùng**:
  - Đăng nhập Google (Google Sign-In) hoặc Email/Mật khẩu với tính năng Quên mật khẩu.
  - Phân vùng dữ liệu độc lập cho từng giáo viên trên Google Cloud Firestore (`users/{uid}/...`).
  - Firestore Security Rules bảo vệ nghiêm ngặt: chỉ giáo viên sở hữu mới có quyền đọc và ghi dữ liệu của mình.
- **Tạo đề thi bằng AI (SGK Global Success)**:
  - Hỗ trợ tạo đề kiểm tra thường xuyên (KTTX – 25 câu), kiểm tra định kì (KTĐK – 32 câu) và đề thi thử tốt nghiệp THPT 40 câu (Format 2025).
  - Soạn bài đọc ngắn chuẩn SGK và hệ thống câu hỏi phân hóa từ nhận biết đến vận dụng.
  - Lưu vào Kho đề, làm thử trực tiếp trên phòng thi hoặc giao cho học sinh.
- **Phòng thi thử THPT Quốc Gia (Format 2025)**:
  - Chia đôi màn hình (bên trái bài đọc/ngữ liệu, bên phải câu hỏi), thước câu hỏi tiện lợi, đồng hồ đếm ngược, nộp bài và chấm điểm tự động.
- **Luyện nói với AI (Giám khảo Speaking IELTS)**:
  - Mô phỏng phòng thi Speaking 3 phần, nhận diện giọng nói qua micro và phát âm bằng giọng AI chuẩn Anh - Anh.
- **Quản lý lớp học & Xuất nhập Excel/Word**:
  - Nhập danh sách học sinh từ file Excel `.xlsx`, quản lý bảng điểm, xuất file Word `.docx` và file mẫu học sinh làm bài độc lập.

## Hướng dẫn chạy & Kiểm thử

1. Khởi động server:
   ```bash
   node server.js
   ```
2. Truy cập ứng dụng tại `http://localhost:3000`.
3. Đăng nhập tài khoản giáo viên.
4. Chọn menu **"Tạo đề"**, chọn SGK Global Success (Khối 10, 11 hoặc 12), chọn định dạng **"KTTX – Kiểm tra thường xuyên (25 câu)"** rồi bấm **"Bắt đầu tạo đề bằng AI"**.
