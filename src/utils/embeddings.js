/**
 * Cloudflare Workers AI의 다국어 임베딩 모델(bge-m3)로 텍스트를 벡터로 변환.
 * 한 번에 배치로 호출해서 요청 수를 최소화한다.
 *
 * 실패(바인딩 미설정, 일시적 장애 등)에 대비해 예외를 던지지 않고 각 항목에 null을 채워 반환한다.
 * 호출부는 embedding이 null인 항목을 "임베딩 없음"으로 취급하고 안전하게 건너뛰어야 한다.
 *
 * @param {Ai} ai - env.AI 바인딩
 * @param {string[]} texts
 * @returns {Promise<(number[]|null)[]>} texts와 같은 순서/길이의 벡터 배열
 */
export async function computeEmbeddings(ai, texts) {
  if (!ai || !texts || texts.length === 0) return texts.map(() => null);

  try {
    const result = await ai.run('@cf/baai/bge-m3', { text: texts });
    // Workers AI 임베딩 모델들은 보통 { shape, data } 형태로 응답한다.
    const vectors = result?.data ?? result;
    if (!Array.isArray(vectors) || vectors.length !== texts.length) {
      return texts.map(() => null);
    }
    return vectors;
  } catch {
    return texts.map(() => null);
  }
}

/** 코사인 유사도 (두 벡터의 방향이 얼마나 비슷한지, -1~1, 보통 0~1로 나옴) */
export function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
