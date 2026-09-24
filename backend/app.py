"""AirForge backend: face login (OpenCV YuNet + SFace) + per-user scene storage in MySQL."""
import os, json, base64, threading, urllib.request
from datetime import datetime, timedelta, timezone
from functools import wraps
import cv2, numpy as np, pymysql, jwt
from flask import Flask, request, jsonify
from flask_cors import CORS
from dotenv import load_dotenv

load_dotenv()
BASE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(BASE, "models"); os.makedirs(MODELS, exist_ok=True)
ZOO = "https://github.com/opencv/opencv_zoo/raw/main/models/"
FILES = {
    "det.onnx": ZOO + "face_detection_yunet/face_detection_yunet_2023mar.onnx",
    "rec.onnx": ZOO + "face_recognition_sface/face_recognition_sface_2021dec.onnx",
}
for n, u in FILES.items():
    p = os.path.join(MODELS, n)
    if not os.path.exists(p):
        print(f"Downloading model {n} ..."); urllib.request.urlretrieve(u, p)

detector = cv2.FaceDetectorYN.create(os.path.join(MODELS, "det.onnx"), "", (320, 320), 0.85, 0.3, 5000)
recognizer = cv2.FaceRecognizerSF.create(os.path.join(MODELS, "rec.onnx"), "")
lock = threading.Lock()
THRESH = 0.363  # SFace cosine threshold (higher = stricter)
SECRET = os.getenv("JWT_SECRET", "dev-secret-change-me")

def embed(data_url):
    raw = base64.b64decode(data_url.split(",")[-1])
    img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    if img is None: return None
    with lock:
        detector.setInputSize((img.shape[1], img.shape[0]))
        _, faces = detector.detect(img)
        if faces is None: return None
        f = max(faces, key=lambda r: r[2] * r[3])
        v = recognizer.feature(recognizer.alignCrop(img, f))[0]
    return v / (np.linalg.norm(v) + 1e-9)

def score(a, b): return float(np.dot(a, b))

# ---------- MySQL ----------
DBC = dict(host=os.getenv("DB_HOST", "localhost"), port=int(os.getenv("DB_PORT", 3306)),
           user=os.getenv("DB_USER", "root"), password=os.getenv("DB_PASSWORD", ""),
           autocommit=True, cursorclass=pymysql.cursors.DictCursor)
DBN = os.getenv("DB_NAME", "airforge")

def q(sql, args=(), one=False):
    c = pymysql.connect(database=DBN, **DBC)
    try:
        cur = c.cursor(); cur.execute(sql, args)
        return (cur.fetchone() if one else cur.fetchall()) if cur.description else cur.lastrowid
    finally: c.close()

def init_db():
    c = pymysql.connect(**DBC); c.cursor().execute(f"CREATE DATABASE IF NOT EXISTS `{DBN}`"); c.close()
    q("CREATE TABLE IF NOT EXISTS users (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(80) UNIQUE NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)")
    q("CREATE TABLE IF NOT EXISTS faces (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, embedding TEXT NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)")
    q("CREATE TABLE IF NOT EXISTS scenes (user_id INT PRIMARY KEY, data LONGTEXT NOT NULL, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)")

def best_match(v, user_id=None):
    rows = q("SELECT f.user_id, u.name, f.embedding FROM faces f JOIN users u ON u.id=f.user_id" + (" WHERE f.user_id=%s" if user_id else ""), (user_id,) if user_id else ())
    best = (None, None, -1.0)
    for r in rows:
        s = score(v, np.array(json.loads(r["embedding"]), dtype=np.float32))
        if s > best[2]: best = (r["user_id"], r["name"], s)
    return best if best[2] >= THRESH else (None, None, best[2])

# ---------- API ----------
app = Flask(__name__); CORS(app)

def auth(fn):
    @wraps(fn)
    def w(*a, **k):
        try: request.uid = jwt.decode(request.headers.get("Authorization", "")[7:], SECRET, algorithms=["HS256"])["uid"]
        except Exception: return jsonify(error="Session expired. Unlock with your face again."), 401
        return fn(*a, **k)
    return w

def token(uid): return jwt.encode({"uid": uid, "exp": datetime.now(timezone.utc) + timedelta(hours=12)}, SECRET, algorithm="HS256")

@app.post("/api/face/register")
def register():
    d = request.json; name = (d.get("name") or "").strip()[:80]
    vs = [v for v in (embed(i) for i in d.get("images", [])) if v is not None]
    if not name: return jsonify(error="Enter a name."), 400
    if len(vs) < 2: return jsonify(error="Face not clear. Look straight at the camera in good light."), 400
    _, who, _ = best_match(vs[0])
    if who and who != name: return jsonify(error=f"This face is already registered as '{who}'."), 409
    if q("SELECT id FROM users WHERE name=%s", (name,), one=True): return jsonify(error="That name is taken."), 409
    uid = q("INSERT INTO users(name) VALUES(%s)", (name,))
    for v in vs: q("INSERT INTO faces(user_id, embedding) VALUES(%s,%s)", (uid, json.dumps(v.tolist())))
    return jsonify(ok=True)

@app.post("/api/face/login")
def login():
    v = embed(request.json.get("image", ""))
    if v is None: return jsonify(match=False, reason="no_face")
    uid, name, s = best_match(v)
    if not uid: return jsonify(match=False, reason="unknown")
    return jsonify(match=True, name=name, token=token(uid), score=round(s, 3))

@app.post("/api/face/verify")
@auth
def verify():
    v = embed(request.json.get("image", ""))
    if v is None: return jsonify(match=False, reason="no_face")
    uid, _, _ = best_match(v, request.uid)
    return jsonify(match=bool(uid))

@app.get("/api/scene")
@auth
def get_scene():
    r = q("SELECT data FROM scenes WHERE user_id=%s", (request.uid,), one=True)
    return jsonify(objects=json.loads(r["data"]) if r else [])

@app.put("/api/scene")
@auth
def put_scene():
    q("REPLACE INTO scenes(user_id, data) VALUES(%s,%s)", (request.uid, json.dumps(request.json.get("objects", []))))
    return jsonify(ok=True)

if __name__ == "__main__":
    init_db(); app.run(port=5000, threaded=True)
