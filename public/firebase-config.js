// Firebase の Web 用設定(公開して問題ない値。アクセス制御は firestore.rules とログインで行う)
export const firebaseConfig = {
  apiKey: "AIzaSyCkv3oXatn-Df7m2HbeTYblH2Y47KuVDkw",
  authDomain: "hac-register-2026.web.app",
  projectId: "hac-register-2026",
  storageBucket: "hac-register-2026.firebasestorage.app",
  messagingSenderId: "605359403204",
  appId: "1:605359403204:web:4fb33bc30ad91ad4e81991",
};

// ログインできる Google アカウント(小文字)。増やすときは firestore.rules も同じように直す
export const allowedEmails = [
  "hac.hosei@gmail.com",
  "kuritaku2202@gmail.com",
];
