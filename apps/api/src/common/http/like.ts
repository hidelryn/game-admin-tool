/** LIKE 패턴용 이스케이프 (사용자 입력의 %, _ 를 문자 그대로 검색) */
export const escapeLike = (v: string) => v.replace(/[\\%_]/g, (c) => `\\${c}`);
