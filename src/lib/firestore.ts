import { getFirestore } from "firebase/firestore";
import { firebaseApp } from "./firebase";

/**
 * The project database. Its own module, imported only by the project store
 * (./projects), so Firestore downloads with the app instead of with sign-in
 * and the launch screen.
 */
export const db = getFirestore(firebaseApp);
