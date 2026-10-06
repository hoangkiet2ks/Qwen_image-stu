# Bản mã nguồn để chia sẻ

Bản này không kèm lịch sử chat, ảnh người dùng, .env, log, model, APK hoặc công cụ build. Cấu hình máy gốc đã được thay bằng mẫu.

1. Cài Node.js, ComfyUI và các custom node/model Qwen tương ứng với server.js.
2. Copy .env.example thành .env và đặt đường dẫn input/output ComfyUI của bạn.
3. Chạy npm ci ở backend và client. Chạy npm start ở backend và npm run dev ở client.
4. APK: đặt VITE_API_BASE bằng URL máy AI trước khi build hoặc lưu URL trong Kết nối máy AI. Cấu hình JAVA_HOME và ANDROID_HOME theo máy của bạn.
5. Script Tailscale cần COMFYUI_PORTABLE_ROOT là thư mục ComfyUI portable. Nếu tailscale.exe không trong PATH, đặt TAILSCALE_EXE. Hostname được lấy tự động từ Tailscale.

Tạo Git repository ngay trong thư mục comfy-proxy này. Kiểm tra git status và git diff --cached trước khi commit. Không add -f các file bị ignore. Không đưa thư mục dự phòng riêng tư bên cạnh vào repo.

Backend hiện không có đăng nhập ứng dụng. Chạy cục bộ hoặc trong mạng riêng với người bạn cho phép. Chia sẻ source không chia sẻ ảnh; quyền truy cập backend đang chạy có thể cho phép xem lịch sử và kho ảnh của backend đó.
