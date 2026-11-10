// MagicPodsCore: https://github.com/steam3d/MagicPodsCore
// Copyright: 2020-2026 Aleksandr Maslov <https://magicpods.app> & Andrei Litvintsev <a.a.litvintsev@gmail.com>
// License: GPL-3.0
// Tragus (https://github.com/jimas21/tragus): owned copy of one setting, so a reader never
// holds a pointer into the settings table while another thread changes it.

#pragma once

#include <toml++/toml.h>

namespace MagicPodsCore {

class SettingValue {
private:
    // One entry, "v", or empty when the setting does not exist. mutable: toml++'s
    // non-const node_view is what the existing callers take.
    mutable toml::table _holder{};

public:
    SettingValue() = default;
    explicit SettingValue(toml::node_view<toml::node> source) {
        if (source)
            _holder.insert_or_assign("v", *source.node());
    }

    // Valid as long as this SettingValue lives.
    toml::node_view<toml::node> view() const { return _holder["v"]; }

    explicit operator bool() const { return static_cast<bool>(view()); }
    bool is_boolean() const { return view().is_boolean(); }
    bool is_integer() const { return view().is_integer(); }
    bool is_string() const { return view().is_string(); }
    auto as_boolean() const { return view().as_boolean(); }
    auto as_integer() const { return view().as_integer(); }
    auto as_string() const { return view().as_string(); }
};

}
