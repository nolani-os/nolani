package foldersync

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// Immich uploads images to Immich — same fields as the Android app
// (ImmichUploadWorker), so both devices hit the server's same dedup logic:
// Immich recognises repeats by deviceAssetId + deviceId.
type Immich struct {
	BaseURL string
	APIKey  string
}

func (i *Immich) Name() string { return "immich-sync" }

func (i *Immich) Accepts(p string) bool {
	// Deliberately images only — videos are large and belong (as on Android) to
	// the Immich app itself; otherwise two paths would shovel the same files.
	return HasExt(p, ".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".gif", ".tif", ".tiff", ".dng")
}

func (i *Immich) Upload(ctx context.Context, client *http.Client, path, assetID, deviceID string) (int, error) {
	f, err := os.Open(path)
	if err != nil {
		return ResultFailed, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return ResultFailed, err
	}

	// Building the multipart body in memory would cost needless RAM for large
	// images → pipe, the body is streamed while sending.
	pr, pw := io.Pipe()
	mw := multipart.NewWriter(pw)
	go func() {
		defer pw.Close()
		defer mw.Close()
		ts := info.ModTime().UTC().Format(time.RFC3339)
		for k, v := range map[string]string{
			"deviceAssetId":  assetID,
			"deviceId":       deviceID,
			"fileCreatedAt":  ts,
			"fileModifiedAt": ts,
			"isFavorite":     "false",
		} {
			_ = mw.WriteField(k, v)
		}
		part, err := mw.CreateFormFile("assetData", filepath.Base(path))
		if err != nil {
			_ = pw.CloseWithError(err)
			return
		}
		if _, err := io.Copy(part, f); err != nil {
			_ = pw.CloseWithError(err)
		}
	}()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, i.BaseURL+"/api/assets", pr)
	if err != nil {
		return ResultFailed, err
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("x-api-key", i.APIKey)
	req.Header.Set("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return ResultFailed, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return ResultFailed, fmt.Errorf("immich HTTP %d: %s", resp.StatusCode, snippet(body))
	}
	var r struct {
		Status string `json:"status"`
	}
	if json.Unmarshal(body, &r) == nil && r.Status == "duplicate" {
		return ResultDuplicate, nil
	}
	return ResultUploaded, nil
}

func snippet(b []byte) string {
	b = bytes.TrimSpace(b)
	if len(b) > 160 {
		b = b[:160]
	}
	return string(b)
}
