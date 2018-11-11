# This file is auto-generated from the current state of the database. Instead
# of editing this file, please use the migrations feature of Active Record to
# incrementally modify your database, and then regenerate this schema definition.
#
# Note that this schema.rb definition is the authoritative source for your
# database schema. If you need to create the application database on another
# system, you should be using db:schema:load, not running all the migrations
# from scratch. The latter is a flawed and unsustainable approach (the more migrations
# you'll amass, the slower it'll run and the greater likelihood for issues).
#
# It's strongly recommended that you check this file into your version control system.

ActiveRecord::Schema.define(version: 2018_11_11_174840) do

  create_table "articles", force: :cascade do |t|
    t.string "title", null: false
    t.text "content", null: false
    t.string "image_link"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.integer "event_registry_uri"
    t.string "news_url"
    t.datetime "published_time"
    t.string "source"
    t.string "image_url"
    t.index ["event_registry_uri"], name: "index_articles_on_event_registry_uri"
  end

  create_table "articles_partidos", id: false, force: :cascade do |t|
    t.integer "partido_id"
    t.integer "article_id"
    t.index ["article_id"], name: "index_articles_partidos_on_article_id"
    t.index ["partido_id"], name: "index_articles_partidos_on_partido_id"
  end

  create_table "partidos", force: :cascade do |t|
    t.string "party_name", null: false
    t.string "description", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.integer "deputies_republic_chamber"
    t.integer "deputies_acores_legislative_chamber"
    t.integer "deputies_madeira_legislative_chamber"
    t.integer "member_europen_parlament"
    t.integer "president_town_hall"
    t.integer "councilmen_municipal"
  end

end
