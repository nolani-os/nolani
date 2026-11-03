//go:build !windows

package state

// Linux/Unix: file mode 0600 suffices (rationale in the package comment) —
// content stays plain-text JSON.
func encryptSecrets(plain []byte) ([]byte, error)  { return plain, nil }
func decryptSecrets(stored []byte) ([]byte, error) { return stored, nil }
