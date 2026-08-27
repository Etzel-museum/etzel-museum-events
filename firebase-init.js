import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyByseHcR_-cXW8MTQfC11SR3MDqJwhewLM",
  authDomain: "etzel-museum-events.firebaseapp.com",
  projectId: "etzel-museum-events",
  storageBucket: "etzel-museum-events.firebasestorage.app",
  messagingSenderId: "792662745222",
  appId: "1:792662745222:web:5149dac5004c1c7fceb107"
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
