# AirForge - sculpt 3D shapes in the air

Face unlock (OpenCV YuNet + SFace) -> per-user workspace -> draw with thumb + index finger in front of the webcam
(MediaPipe hand tracking) -> shapes appear as editable 3D objects (Three.js). Figures are saved per user in MySQL.

Stack: React + Vite (frontend), Python Flask (backend), MySQL (database).

## Setup
1. Install: Python 3.10+, Node.js 18+, MySQL 8 (running).
2. Backend
   cd backend
   python -m venv venv
   venv\Scripts\activate          (Mac/Linux: source venv/bin/activate)
   pip install -r requirements.txt
   copy .env.example .env         (Mac/Linux: cp .env.example .env) and put your MySQL password in it
   python app.py
   First run downloads two small face models and creates the `airforge` database + tables automatically.
3. Frontend (new terminal)
   cd frontend
   npm install
   npm run dev
4. Open http://localhost:5173 and allow the camera.
   New face tab -> type name -> Save my face. Then Face unlock tab -> workspace opens.

## Gestures
- Pinch (thumb + index touching) and move = draw an amber stroke. Release = shape is recognised.
  circle -> sphere, rectangle -> box, triangle -> pyramid, straight line -> rod
- Fist and move = rotate the whole scene. Mouse drag/scroll also orbits and zooms. Click an object to select it.
- Right panel: length / height / breadth, edges (sides), position, tilt, colour, outline, wireframe.

## Notes
- Internet is needed on first run (face models, MediaPipe hand model and wasm are fetched from CDNs).
- Every 5 s the workspace re-checks the face; if another/no face is seen, hand control pauses.
- Face check has no liveness detection (a printed photo could fool it). Do not use it to protect sensitive data.
- Tweak face strictness with THRESH in backend/app.py (default 0.363).
