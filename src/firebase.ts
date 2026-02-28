import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyDYf7Gd-Ai4p7_JBzUT5NWro6ENhQ2P5oI",
  authDomain: "mini-a9a43.firebaseapp.com",
  projectId: "mini-a9a43",
  storageBucket: "mini-a9a43.firebasestorage.app",
  messagingSenderId: "710951421511",
  appId: "1:710951421511:web:e1b1ab2c1e1d06a6af9362",
};

const app = initializeApp(firebaseConfig);

export const db = getFirestore(app);