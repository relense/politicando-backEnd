class AddColumnToArticles < ActiveRecord::Migration[5.2]
  def change
    add_column :articles, :event_registry_uri, :integer
    add_column :articles, :news_url, :string
    add_column :articles, :published_time ,:datetime

    add_index :articles, :event_registry_uri
  end
end
