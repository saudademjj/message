package server

func missingReadyDeviceCount(activeDeviceCount, readyDeviceCount int64) int64 {
	if activeDeviceCount <= 0 || readyDeviceCount >= activeDeviceCount {
		return 0
	}
	if readyDeviceCount < 0 {
		readyDeviceCount = 0
	}
	return activeDeviceCount - readyDeviceCount
}
