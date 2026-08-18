const fs = require('fs');
const path = require('path');

const IMAGES_DIR = path.join(__dirname, '..', 'public', 'images');
const VALID_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];

// images/ 폴더에 있는 카드 이미지 파일 목록을 읽어 정적 서빙 경로(URL) 배열로 반환한다.
// 실제 이미지 파일은 사용자가 로컬 images/ 폴더에 직접 채워 넣는다.
function loadImageList() {
  if (!fs.existsSync(IMAGES_DIR)) {
    console.warn(`[imageLoader] 이미지 폴더를 찾을 수 없습니다: ${IMAGES_DIR}`);
    return [];
  }

  const files = fs
    .readdirSync(IMAGES_DIR)
    .filter((file) => VALID_EXTENSIONS.includes(path.extname(file).toLowerCase()));

  return files.map((file) => `/images/${file}`);
}

module.exports = { loadImageList, IMAGES_DIR };
