package foldersync

import (
	"context"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// Paperless uploads documents to the Paperless inbox (like PaperlessUploader on
// Android: POST /api/documents/post_document/ with a DRF token).
//
// 🔑 Paperless has no device identifier like Immich — it only answers with a
// task ID and discards duplicates server-side by content hash. Our dedup
// responsibility therefore lies entirely with the local cursor.
type Paperless struct {
	BaseURL string
	Token   string
}

func (p *Paperless) Name() string { return "paperless-sync" }

func (p *Paperless) Accepts(path string) bool {
	return HasExt(path, ".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".txt", ".odt", ".docx")
}

func (p *Paperless) Upload(ctx context.Context, client *http.Client, path, assetID, deviceID string) (int, error) {
	f, err := os.Open(path)
	if err != nil {
		return ResultFailed, err
	}
	defer f.Close()

	// 🔴 Unlike Immich, the body here MUST have a known length.
	// A streamed body (io.Pipe) produces `Transfer-Encoding: chunked`, and
	// Django's multipart parser then sees an EMPTY file — Paperless answers
	// with `400 {"document":["No file was submitted."]}`.
	// Seen in production; unit tests with Go's own server don't show it, because
	// that handles chunked cleanly. Hence: build the body in a temporary file
	// (not in memory — scans can be large) and set ContentLength.
	tmp, err := os.CreateTemp("", "claraos-upload-*")
	if err != nil {
		return ResultFailed, err
	}
	defer func() {
		tmp.Close()
		_ = os.Remove(tmp.Name())
	}()

	mw := multipart.NewWriter(tmp)
	part, err := mw.CreateFormFile("document", filepath.Base(path))
	if err != nil {
		return ResultFailed, err
	}
	if _, err := io.Copy(part, f); err != nil {
		return ResultFailed, err
	}
	if err := mw.Close(); err != nil {
		return ResultFailed, err
	}
	size, err := tmp.Seek(0, io.SeekEnd)
	if err != nil {
		return ResultFailed, err
	}
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		return ResultFailed, err
	}

	url := strings.TrimSuffix(p.BaseURL, "/") + "/api/documents/post_document/"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, tmp)
	if err != nil {
		return ResultFailed, err
	}
	req.ContentLength = size
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Token "+p.Token)
	req.Header.Set("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return ResultFailed, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		// 409 = Paperless already knows the document → count it as a duplicate,
		// otherwise the cursor retries it until the end of time.
		if resp.StatusCode == http.StatusConflict {
			return ResultDuplicate, nil
		}
		return ResultFailed, fmt.Errorf("paperless HTTP %d: %s", resp.StatusCode, snippet(body))
	}
	return ResultUploaded, nil
}
