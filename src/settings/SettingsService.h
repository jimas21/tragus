// MagicPodsCore: https://github.com/steam3d/MagicPodsCore
// Copyright: 2020-2026 Aleksandr Maslov <https://magicpods.app> & Andrei Litvintsev <a.a.litvintsev@gmail.com>
// License: GPL-3.0

#pragma once

#include <map>
#include <mutex>
#include <optional>
#include <vector>
#include <string>
#include <type_traits>
#include <toml++/toml.h>
#include "Event.h"
#include "SettingValue.h"
#include "UpdatedSettingNotification.h"

namespace MagicPodsCore {

class SettingsService {
private:
    toml::table _settings{};
    std::string _filePath;
    ThreadSafeEvent<UpdatedSettingNotification> _onSettingUpdate{};
    // Tragus: settings are read and saved from several threads (WebSocket loop, device
    // reader, BLE). Every access to _settings and every file write holds this lock;
    // change events fire after it is released, with their own copy of the value.
    mutable std::recursive_mutex _mutex;

    void LoadFromFile();
    void WriteToFile();
    void RemoveStaleTempFiles();
    void Fire(const std::vector<UpdatedSettingNotification>& notifications);
    static toml::table GetDefaults();

    static void MergeDefaults(toml::table& settings, const toml::table& defaults) {
        for (const auto& [containerName, containerData] : defaults) {
            auto* defaultContainer = containerData.as_table();
            if (!defaultContainer) continue;

            if (!settings[containerName].as_table()) {
                settings.insert_or_assign(containerName, toml::table{});
            }
            auto* settingsContainer = settings[containerName].as_table();

            for (const auto& [key, value] : *defaultContainer) {
                if (!(*settingsContainer)[key]) {
                    settingsContainer->insert_or_assign(key, value);
                }
            }
        }
    }

public:
    SettingsService(const std::string& filePath);
    // All getters return copies (Tragus), safe to use while other threads save.
    toml::table GetSettingsAll();
    toml::table GetSettingsAllWrapped();
    toml::table GetSettings(const std::string& container);
    SettingValue GetSetting(const std::string& container, const std::string& name);

    void SaveSettings(const toml::table& table);

    template<typename T>
    void SaveSetting(const std::string& container, const std::string& name, T&& value);

    void SaveSetting(const std::string& container, const std::string& name, const toml::node& value);
    void SaveSetting(const std::string& container, const std::string& name, const toml::node_view<const toml::node>& value);

    ThreadSafeEvent<UpdatedSettingNotification>& GetOnSettingUpdateEvent() {
        return _onSettingUpdate;
    }

    static std::string GetConfigPath(const std::string &fileName);
};

template<typename T>
void SettingsService::SaveSetting(const std::string& container, const std::string& name, T&& value) {
    std::vector<UpdatedSettingNotification> notifications;
    {
        std::lock_guard<std::recursive_mutex> lock(_mutex);
        auto containerTable = _settings[container].as_table();
        if (!containerTable) {
            _settings.insert_or_assign(container, toml::table{});
            containerTable = _settings[container].as_table();
        }
        containerTable->insert_or_assign(name, std::forward<T>(value));
        WriteToFile();
        notifications.emplace_back(container, name, (*containerTable)[name]);
    }
    Fire(notifications);
}

}
